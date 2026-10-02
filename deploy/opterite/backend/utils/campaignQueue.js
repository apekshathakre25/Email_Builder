/**
 * Sequential execution of one operator's campaigns, arbitrated by Redis.
 *
 * THE PROBLEM. Sending runs in the worker processes off a single shared Bull queue,
 * and nothing has ever stopped two browser tabs submitting at once: each tab posts
 * its own /send-email and the jobs interleave. An operator who stages 70,000
 * addresses in one tab and 30,000 in another and starts both gets both campaigns
 * racing through the same SMTP connection pool and the same rate-limit bucket.
 *
 * WHAT THIS IS. A FIFO "lane" per operator. One campaign holds the lane at a time;
 * the rest wait their turn and are promoted automatically as it frees. The browser
 * asks the lane whether it may start and does not submit until told to, so ordering
 * is decided by the server and the same answer is given to every tab and every one
 * of the four web instances.
 *
 * WHY REDIS AND NOT THE BROWSER. BroadcastChannel and localStorage events only reach
 * tabs that are currently open in one browser profile, are invisible to the workers
 * that actually send, and are lost the moment a tab is closed. The state that
 * matters here — is a campaign still sending — is known only to the backend, so the
 * backend has to own the decision. Redis is already the coordination point for the
 * queue, the stop markers and the rate limiter, so it is where this belongs too.
 *
 * STATES, and who moves them:
 *
 *   WAITING    a tab asked for the lane while another campaign held it
 *   QUEUED     this campaign now holds the lane; the tab is cleared to submit
 *   SENDING    the tab has submitted and jobs are enqueued
 *   COMPLETED  every recipient settled (sent + failed >= total)
 *   FAILED     the campaign stalled with nothing left in flight
 *   CANCELLED  the operator stopped it
 *
 *   WAITING -> QUEUED        promote(), when the previous holder releases
 *   QUEUED  -> SENDING       markSending(), exactly once per campaign
 *   SENDING -> terminal      release(), from the reconciler in routes/campaignQueue
 *
 * ATOMICITY. Claim, start and release are Lua, so they are single Redis operations.
 * Four web instances can serve three tabs' polls simultaneously; without that, two
 * of them could read an empty lane and both promote, or one campaign could be
 * started twice. There is no lock to acquire because Redis has already serialised it.
 *
 * SCOPE NOTE. Keys are built by string concatenation inside the Lua, which assumes a
 * single Redis instance rather than a cluster. That matches this deployment (one
 * `redis` service in docker-compose) and the rest of the codebase, which does the
 * same thing throughout utils/sessionKeys.js.
 */

const { sessionKeyTtlSeconds } = require('./sessionKeys');

const LANE_PREFIX = 'campaignlane';
const ACTIVE_PREFIX = 'campaignactive';
const SLOT_PREFIX = 'campaignslot';

const STATES = Object.freeze({
  WAITING: 'WAITING',
  QUEUED: 'QUEUED',
  SENDING: 'SENDING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
  /**
   * Everything this Send Email action released has settled, but the campaign still has
   * unsent entries — the operator set "Limit to Send" and that cap was reached.
   *
   * Terminal for the *lane* and not for the *campaign*: the turn is over, so anything
   * queued behind it runs, but `EmailLog.status` stays `in_progress`, the remaining
   * entries stay pending, and nothing starts again until the operator clicks Send Email.
   * Kept distinct from COMPLETED (nobody is left), FAILED (it stopped going out) and
   * CANCELLED (the operator halted it), all three of which would misreport this.
   */
  PAUSED: 'PAUSED'
});

const TERMINAL_STATES = Object.freeze([
  STATES.COMPLETED,
  STATES.FAILED,
  STATES.CANCELLED,
  STATES.PAUSED
]);

/**
 * How long the lane holder's claim survives without being refreshed.
 *
 * This is a backstop, not the mechanism: the reconciler in routes/campaignQueue is
 * what normally ends a campaign's turn, and it re-asserts this TTL on every poll
 * while the campaign is still live. The expiry only matters when nothing is polling
 * at all — a browser closed mid-campaign — where it stops a dead claim from blocking
 * the operator's next campaign forever. Six hours is long enough that a large paced
 * campaign with a waiting tab behind it is never cut off, since any waiting tab's
 * poll slides it forward.
 */
const ACTIVE_TTL_SECONDS = 6 * 60 * 60;

/**
 * How long a WAITING or QUEUED campaign may go unseen before its tab is presumed gone.
 *
 * A waiting tab polls GET /campaign-lane every 2s, and each poll stamps `lastSeenMs`.
 * That poll IS the liveness signal, which is what lets a closed tab be told apart from
 * a refreshed one: a reload misses at most one or two polls, a closed tab misses all of
 * them forever. 15s is ~7 missed polls — long enough that a slow reload, a stalled
 * event loop or a brief network drop never loses a place in the queue, short enough
 * that a closed tab does not hold up the operator's next campaign.
 *
 * Deliberately NOT consulted for a SENDING campaign. Once jobs are enqueued the workers
 * own the campaign and it must run to completion whether or not any browser is watching;
 * a SENDING campaign is judged by progress instead (see reconcileActive).
 */
const HEARTBEAT_STALE_MS = 15 * 1000;

/** Slots outlive their campaign so a refreshed tab can still read a terminal state. */
function slotTtlSeconds() {
  return Math.max(ACTIVE_TTL_SECONDS, Math.min(sessionKeyTtlSeconds(), 7 * 24 * 60 * 60));
}

function laneKey(userId) {
  return `${LANE_PREFIX}:${userId}`;
}

function activeKey(userId) {
  return `${ACTIVE_PREFIX}:${userId}`;
}

function slotKey(campaignId) {
  return `${SLOT_PREFIX}:${campaignId}`;
}

function nowIso() {
  return new Date().toISOString();
}

/**
 * Takes the lane, or joins the back of it.
 *
 * Idempotent per campaign, which is what makes a refresh safe: a tab that reloads
 * mid-campaign calls this again and is told it is already SENDING rather than being
 * queued a second time or restarted. A campaign already waiting keeps its place
 * instead of being pushed to the back.
 *
 * Returns { state, position, activeCampaignId }. `position` is 0 when this campaign
 * holds the lane, otherwise its 1-based place in the queue.
 */
const CLAIM_SCRIPT = `
local active = redis.call('GET', KEYS[1])
local state  = redis.call('HGET', KEYS[3], 'state')

-- Already sending. Say so and change nothing: this is a reload, not a new start.
if state == 'SENDING' then
  return {'SENDING', '0', active or ''}
end

-- A run that actually happened. Report the outcome rather than silently starting it
-- again, so the caller can say "this campaign has already finished".
if state == 'COMPLETED' or state == 'FAILED' then
  return {state, '0', active or ''}
end

-- CANCELLED is deliberately NOT terminal for claiming. It means this run did not
-- happen — the operator stopped it, gave up its place, or its tab went quiet and it was
-- passed over — and in every one of those cases the campaign still holds its pending
-- recipients. A tab that comes back and asks again must get back in line; short-
-- circuiting here meant a reload slower than the heartbeat window killed the campaign
-- permanently, with no way to restart it.

local function take()
  redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[5])
  redis.call('LREM', KEYS[2], 0, ARGV[1])
  redis.call('HSET', KEYS[3],
    'userId', ARGV[2], 'campaignId', ARGV[1], 'state', 'QUEUED',
    'claimedAt', ARGV[3], 'total', ARGV[4], 'lastProgressAt', ARGV[3],
    'lastSeenAt', ARGV[3], 'lastSeenMs', ARGV[7])
  redis.call('EXPIRE', KEYS[3], ARGV[6])
  return {'QUEUED', '0', ARGV[1]}
end

if not active or active == false then return take() end
if active == ARGV[1] then return take() end

-- Someone else holds the lane. Join it exactly once.
local items = redis.call('LRANGE', KEYS[2], 0, -1)
local pos = -1
for i, v in ipairs(items) do
  if v == ARGV[1] then pos = i break end
end

if pos == -1 then
  redis.call('RPUSH', KEYS[2], ARGV[1])
  pos = redis.call('LLEN', KEYS[2])
end
redis.call('EXPIRE', KEYS[2], ARGV[6])

redis.call('HSET', KEYS[3],
  'userId', ARGV[2], 'campaignId', ARGV[1], 'state', 'WAITING',
  'claimedAt', ARGV[3], 'total', ARGV[4],
  'lastSeenAt', ARGV[3], 'lastSeenMs', ARGV[7])
redis.call('EXPIRE', KEYS[3], ARGV[6])

return {'WAITING', tostring(pos), active}
`;

async function claim(redis, { userId, campaignId, total = 0 }) {
  if (!redis || !userId || !campaignId) {
    throw new TypeError('claim requires a Redis client, userId and campaignId.');
  }

  const [state, position, active] = await redis.eval(
    CLAIM_SCRIPT, 3,
    activeKey(userId), laneKey(userId), slotKey(campaignId),
    campaignId, userId, nowIso(), String(total),
    String(ACTIVE_TTL_SECONDS), String(slotTtlSeconds()), String(Date.now())
  );

  return {
    state,
    position: Number(position) || 0,
    activeCampaignId: active || null
  };
}

/**
 * Moves a campaign that holds the lane from QUEUED to SENDING.
 *
 * The single guard against the same campaign being started twice — by a
 * double-click, by two tabs showing the same file, or by a tab that reloaded and
 * decided to submit again. Only the lane holder can transition, and only from a
 * non-SENDING state, so the second caller gets 'ALREADY' and must not submit.
 *
 * Returns { ok, reason, activeCampaignId }.
 */
const MARK_SENDING_SCRIPT = `
local active = redis.call('GET', KEYS[1])
if not active or active == false then return {'DENIED', 'lane not held', ''} end
if active ~= ARGV[1] then return {'DENIED', 'another campaign holds the lane', active} end

local state = redis.call('HGET', KEYS[2], 'state')
if state == 'SENDING' then return {'ALREADY', 'already sending', active} end
if state == 'COMPLETED' or state == 'FAILED' or state == 'CANCELLED' then
  return {'DENIED', 'campaign already finished', active}
end

redis.call('HSET', KEYS[2],
  'state', 'SENDING', 'startedAt', ARGV[2], 'lastProgressAt', ARGV[2])
redis.call('EXPIRE', KEYS[2], ARGV[4])
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[3])

return {'OK', 'started', active}
`;

async function markSending(redis, { userId, campaignId }) {
  const [code, reason, active] = await redis.eval(
    MARK_SENDING_SCRIPT, 2,
    activeKey(userId), slotKey(campaignId),
    campaignId, nowIso(), String(ACTIVE_TTL_SECONDS), String(slotTtlSeconds())
  );

  return { ok: code === 'OK', code, reason, activeCampaignId: active || null };
}

/**
 * Ends a campaign's turn and promotes the next campaign whose tab is still there.
 *
 * The terminal state is recorded on the finishing campaign whether or not it held the
 * lane, so a campaign cancelled while still WAITING is marked and removed from the
 * queue rather than left to be promoted later.
 *
 * ABANDONED CAMPAIGNS ARE SKIPPED, NOT STARTED. A waiting tab that has been closed
 * stops heartbeating, and its campaign must not begin sending on its own — the tab is
 * where the operator was watching it, and nobody is there. Each candidate is checked
 * for a recent heartbeat before it is promoted; stale ones are marked CANCELLED and
 * passed over, so a queue of three closed tabs does not stall the fourth. This also
 * means an abandoned campaign can never sit holding the lane, which is what would
 * otherwise block everything behind it until the claim's six-hour expiry.
 *
 * Returns { released, promotedCampaignId, abandonedCampaignIds }.
 */
const RELEASE_SCRIPT = `
redis.call('HSET', KEYS[3], 'state', ARGV[2], 'settledAt', ARGV[3])
redis.call('EXPIRE', KEYS[3], ARGV[5])

local active = redis.call('GET', KEYS[1])

-- Not the holder: drop it from the queue so its turn never comes.
if not active or active == false or active ~= ARGV[1] then
  redis.call('LREM', KEYS[2], 0, ARGV[1])
  return {'NOT_ACTIVE', '', ''}
end

redis.call('DEL', KEYS[1])
redis.call('LREM', KEYS[2], 0, ARGV[1])

local nowMs = tonumber(ARGV[6])
local staleMs = tonumber(ARGV[7])
local abandoned = {}

while true do
  local nextId = redis.call('LPOP', KEYS[2])
  if not nextId or nextId == false then
    return {'RELEASED', '', table.concat(abandoned, ',')}
  end

  local nextSlot = '${SLOT_PREFIX}:' .. nextId
  local seen = redis.call('HGET', nextSlot, 'lastSeenMs')

  local alive = false
  if seen and seen ~= false then
    local seenMs = tonumber(seen)
    if seenMs and (nowMs - seenMs) <= staleMs then alive = true end
  end

  if alive then
    redis.call('SET', KEYS[1], nextId, 'EX', ARGV[4])
    redis.call('HSET', nextSlot,
      'state', 'QUEUED', 'promotedAt', ARGV[3], 'lastProgressAt', ARGV[3])
    redis.call('EXPIRE', nextSlot, ARGV[5])
    return {'RELEASED', nextId, table.concat(abandoned, ',')}
  end

  -- Its tab is gone. Marked so a reopened tab can see what happened, and explicitly
  -- NOT promoted: a campaign nobody is watching must not start sending.
  redis.call('HSET', nextSlot,
    'state', 'CANCELLED', 'settledAt', ARGV[3], 'abandoned', '1')
  redis.call('EXPIRE', nextSlot, ARGV[5])
  table.insert(abandoned, nextId)
end
`;

async function release(redis, { userId, campaignId, state }) {
  if (!TERMINAL_STATES.includes(state)) {
    throw new TypeError(`release requires a terminal state, got "${state}".`);
  }

  const [code, promoted, abandoned] = await redis.eval(
    RELEASE_SCRIPT, 3,
    activeKey(userId), laneKey(userId), slotKey(campaignId),
    campaignId, state, nowIso(),
    String(ACTIVE_TTL_SECONDS), String(slotTtlSeconds()),
    String(Date.now()), String(HEARTBEAT_STALE_MS)
  );

  return {
    released: code === 'RELEASED',
    code,
    promotedCampaignId: promoted || null,
    abandonedCampaignIds: abandoned ? String(abandoned).split(',').filter(Boolean) : []
  };
}

/**
 * Records that a tab is still watching this campaign.
 *
 * Called from every GET /campaign-lane poll. This is the whole liveness mechanism —
 * there is deliberately no "I am closing" beacon, because `pagehide` fires on a
 * refresh exactly as it does on a close, so a beacon cancelled the campaigns of tabs
 * that were merely reloading.
 */
async function heartbeat(redis, campaignId) {
  if (!redis || !campaignId) return;

  const now = Date.now();
  await redis
    .pipeline()
    .hset(slotKey(campaignId), 'lastSeenAt', new Date(now).toISOString(), 'lastSeenMs', String(now))
    .expire(slotKey(campaignId), slotTtlSeconds())
    .exec();
}

/**
 * Whether a slot's tab has stopped checking in.
 *
 * Only meaningful for WAITING and QUEUED. A SENDING campaign is owned by the workers
 * and is judged by progress, never by whether a browser is still open.
 */
function isStale(slot, nowMs = Date.now()) {
  if (!slot) return true;
  if (!slot.lastSeenMs) return true;
  return (nowMs - slot.lastSeenMs) > HEARTBEAT_STALE_MS;
}

/**
 * Drops waiting campaigns whose tabs have gone, marking them CANCELLED.
 *
 * Hygiene rather than correctness — release() already refuses to promote a stale
 * campaign — but it keeps the queue and the "N campaigns ahead of this one" count
 * honest for the tabs that are still open, and stops the list growing without bound
 * across a long session.
 *
 * Returns the ids it removed.
 */
const PRUNE_SCRIPT = `
local items = redis.call('LRANGE', KEYS[1], 0, -1)
local nowMs = tonumber(ARGV[1])
local staleMs = tonumber(ARGV[2])
local removed = {}

for _, id in ipairs(items) do
  local s = '${SLOT_PREFIX}:' .. id
  local seen = redis.call('HGET', s, 'lastSeenMs')

  local alive = false
  if seen and seen ~= false then
    local seenMs = tonumber(seen)
    if seenMs and (nowMs - seenMs) <= staleMs then alive = true end
  end

  if not alive then
    redis.call('LREM', KEYS[1], 0, id)
    redis.call('HSET', s, 'state', 'CANCELLED', 'settledAt', ARGV[3], 'abandoned', '1')
    redis.call('EXPIRE', s, ARGV[4])
    table.insert(removed, id)
  end
end

return removed
`;

async function pruneAbandonedWaiting(redis, userId) {
  if (!redis || !userId) return [];

  const removed = await redis.eval(
    PRUNE_SCRIPT, 1,
    laneKey(userId),
    String(Date.now()), String(HEARTBEAT_STALE_MS), nowIso(), String(slotTtlSeconds())
  );

  return Array.isArray(removed) ? removed : [];
}

/** The recorded state of one campaign, or null when it has never claimed a lane. */
async function readSlot(redis, campaignId) {
  if (!redis || !campaignId) return null;

  const slot = await redis.hgetall(slotKey(campaignId));
  if (!slot || Object.keys(slot).length === 0) return null;

  return {
    campaignId: slot.campaignId || campaignId,
    userId: slot.userId || '',
    state: slot.state || STATES.WAITING,
    total: Number(slot.total) || 0,
    claimedAt: slot.claimedAt || null,
    startedAt: slot.startedAt || null,
    settledAt: slot.settledAt || null,
    lastProgressAt: slot.lastProgressAt || null,
    lastSettled: Number(slot.lastSettled) || 0,
    lastSeenAt: slot.lastSeenAt || null,
    lastSeenMs: Number(slot.lastSeenMs) || 0,
    /** Set when the campaign was passed over because its tab had gone. */
    abandoned: slot.abandoned === '1'
  };
}

/** Which campaign currently holds this operator's lane, if any. */
async function readActive(redis, userId) {
  if (!redis || !userId) return null;
  return (await redis.get(activeKey(userId))) || null;
}

/** The campaigns waiting behind the holder, in the order they will run. */
async function readLane(redis, userId) {
  if (!redis || !userId) return [];
  return (await redis.lrange(laneKey(userId), 0, -1)) || [];
}

/**
 * Records that a campaign is still making progress.
 *
 * Slides the lane claim forward and stores the settled count the reconciler last
 * saw, which is what lets it distinguish "slow" from "stalled" without a timer.
 */
async function noteProgress(redis, { userId, campaignId, settled = 0 }) {
  if (!redis || !userId || !campaignId) return;

  await redis
    .pipeline()
    .hset(slotKey(campaignId), 'lastProgressAt', nowIso(), 'lastSettled', String(settled))
    .expire(slotKey(campaignId), slotTtlSeconds())
    .expire(activeKey(userId), ACTIVE_TTL_SECONDS)
    .exec();
}

/** Refreshes only the claim's expiry, without touching progress bookkeeping. */
async function touchActive(redis, userId) {
  if (!redis || !userId) return;
  await redis.expire(activeKey(userId), ACTIVE_TTL_SECONDS);
}

/** Forgets a campaign's lane state entirely. Used when its data is deleted. */
async function dropSlot(redis, { userId, campaignId }) {
  if (!redis || !campaignId) return;

  const pipeline = redis.pipeline().del(slotKey(campaignId));
  if (userId) pipeline.lrem(laneKey(userId), 0, campaignId);
  await pipeline.exec();
}

module.exports = {
  STATES,
  TERMINAL_STATES,
  ACTIVE_TTL_SECONDS,
  HEARTBEAT_STALE_MS,
  heartbeat,
  isStale,
  pruneAbandonedWaiting,
  LANE_PREFIX,
  ACTIVE_PREFIX,
  SLOT_PREFIX,
  slotTtlSeconds,
  laneKey,
  activeKey,
  slotKey,
  claim,
  markSending,
  release,
  readSlot,
  readActive,
  readLane,
  noteProgress,
  touchActive,
  dropSlot
};
