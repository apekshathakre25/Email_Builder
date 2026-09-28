/**
 * Campaign stop state.
 *
 * WHAT "STOP" MEANS HERE
 * ---------------------
 * There is exactly ONE stop operation: stop the entire campaign. The UI offers
 * two buttons for it — one beside Send Email, one inside the interval popup —
 * and both call the same route, which calls the same functions in this file.
 * There is deliberately no separate "stop the interval" concept: stopping the
 * interval *is* stopping the campaign.
 *
 * WHY THE STATE LIVES IN REDIS
 * ----------------------------
 * The stop is issued to a web process and has to be obeyed by the workers, and
 * those are different OS processes: ecosystem.config.js runs app.js as a PM2
 * cluster and workprocess/mailer.js as 14 forks. A module-level flag would stop
 * nothing at all — the process that set it never sends an email. Redis is the
 * only thing all 18 processes share, and it is already on the per-send path, so
 * the marker goes there and the workers read it before every delivery.
 *
 * This is what makes the stop real rather than cosmetic. The frontend stopping
 * its countdown is a consequence of the stop, never the mechanism.
 *
 * THE RACE, AND WHY THE MARKER IS THE ONLY ARBITER
 * ------------------------------------------------
 * A worker deciding "this campaign is active" and an operator clicking Stop can
 * happen in the same instant. The rule is: **the marker existing in Redis is the
 * commit point.** Before it exists, sends are legitimate. After it exists, no
 * further send may be released. The window is closed by where the check sits:
 *
 *   - Paced campaigns: the check is *inside* the rate limiter's Lua script, in
 *     the same atomic step that consumes a window slot (see
 *     utils/emailRateLimiter.js). Redis is single-threaded, so a slot and the
 *     stop can never both win — once the marker is written, no subsequent
 *     ACQUIRE can hand out capacity.
 *   - Every campaign, paced or not: an unconditional check immediately before
 *     transporter.sendMail, which is the path unpaced legacy jobs take because
 *     they never touch the limiter.
 *
 * A send already past both checks completes. That is intentional and is the
 * "handle active jobs safely" requirement: aborting mid-SMTP cannot be done
 * without risking a delivery we failed to record, which would show up as a
 * duplicate on the next send. One in-flight email finishing is strictly safer.
 *
 * THE RESEND BACKLOG, AND WHY IT HAS TO EXIST
 * -------------------------------------------
 * `sentIndex:<id>` is advanced when recipients are *enqueued*, not when they are
 * sent, and it is the only resume position the campaign has. So every recipient
 * whose job is discarded by the stop has already been counted as "dealt with" —
 * leaving them alone would silently skip them on the next send.
 *
 * Rewinding `sentIndex` instead is not an option: with hundreds of concurrent
 * workers, recipients settle out of order, so "sent + failed = N" does not mean
 * "the first N recipients were attempted". Rewinding to N would re-deliver to
 * anyone past that point who had already received the email.
 *
 * `resend:<id>` therefore records the discarded recipients *by address*, which is
 * exact: those addresses were never handed to a mail server. The next send drains
 * this list before continuing from `sentIndex`, so no one is skipped and no one is
 * mailed twice.
 *
 * Both the stop route (which removes the campaign's waiting and delayed jobs) and
 * the worker (which skips any job that slips past that removal) append here. An
 * address can therefore be recorded at most once per discarded job, and the
 * drain deduplicates anyway.
 */

const {
  sessionKeyTtlSeconds,
  campaignStopKey,
  resendKey
} = require('./sessionKeys');

/**
 * How many recipients one drain will take.
 *
 * Bounded so a stop of a very large campaign cannot turn the next /send-email
 * into an unbounded read. Anything left over is taken by the send after it, which
 * is the same batching the campaign already works in.
 */
const RESEND_DRAIN_MAX = 100000;

/** Cap on the list itself, so a pathological loop cannot grow it without bound. */
const RESEND_MAX_LENGTH = 2000000;

function nowIso() {
  return new Date().toISOString();
}

/**
 * Commits the stop for a campaign.
 *
 * SET NX is what makes this idempotent, and the boolean reply is meaningful: the
 * caller that gets `true` is the one whose click committed the stop, and every
 * other concurrent or repeated click gets `false` and the *original* stop's
 * details. Two operators hitting Stop at once therefore produce one stop, one
 * status transition and one purge, not two of each — and there is no lock to
 * acquire, because Redis has already serialised it.
 *
 * The TTL matches the rest of the session's keys, so a marker cannot outlive the
 * campaign it describes and strand a recipient file that can never be sent again.
 *
 * Returns { committed, stoppedAt, stoppedBy, reason }.
 */
async function stopCampaign(redis, sessionId, { stoppedBy = '', reason = 'operator requested stop' } = {}) {
  if (!redis || !sessionId) {
    throw new TypeError('stopCampaign requires a Redis client and a sessionId.');
  }

  const payload = {
    stoppedAt: nowIso(),
    stoppedBy: String(stoppedBy || ''),
    reason: String(reason || '')
  };

  const reply = await redis.set(
    campaignStopKey(sessionId),
    JSON.stringify(payload),
    'EX',
    sessionKeyTtlSeconds(),
    'NX'
  );

  // ioredis returns 'OK' when NX succeeded and null when the key already existed.
  if (reply === 'OK') return { committed: true, ...payload };

  const existing = await readCampaignStop(redis, sessionId);
  return { committed: false, ...(existing || payload) };
}

/**
 * The stop record, or null when the campaign is not stopped.
 *
 * A marker that cannot be parsed is still a stop. Treating unreadable JSON as
 * "not stopped" would be the one failure mode that lets a stopped campaign keep
 * sending, so the details degrade and the decision does not.
 */
async function readCampaignStop(redis, sessionId) {
  if (!redis || !sessionId) return null;

  const raw = await redis.get(campaignStopKey(sessionId));
  if (raw === null || raw === undefined) return null;

  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {
    // fall through
  }

  return { stoppedAt: null, stoppedBy: '', reason: 'stopped' };
}

/**
 * Whether sending for this campaign is forbidden right now.
 *
 * EXISTS rather than GET: the worker calls this once per email and only needs the
 * decision, not the reason.
 */
async function isCampaignStopped(redis, sessionId) {
  if (!redis || !sessionId) return false;
  return (await redis.exists(campaignStopKey(sessionId))) === 1;
}

/**
 * Lifts the stop, so the campaign can be started again.
 *
 * Called at the top of a new send. This is the whole of "restart after stop" as
 * far as state goes — the new submission brings its own Limit and Interval, and
 * because the old campaign's jobs were removed from the queue rather than parked,
 * nothing from the previous configuration can resume alongside it.
 */
async function clearCampaignStop(redis, sessionId) {
  if (!redis || !sessionId) return 0;
  return redis.del(campaignStopKey(sessionId));
}

/**
 * The identity of a single send, used to recognise the same send recorded twice.
 *
 * Duplicate email addresses are legitimate: a recipient list is a list of sends, so
 * a file holding bob@example.com three times is a request for three emails, and
 * each is tracked independently. The address therefore cannot be the identity —
 * keying on it made three outstanding sends resume as one.
 *
 * `sendId` is assigned by /send-email as `<sourceFile>#<indexInThatFile>`. It is a
 * position in a file's stored recipient list, which is written once at upload and
 * never mutated, so it names exactly one send and stays stable across submissions
 * and across the files being re-selected in a different order.
 *
 * FALLBACK: entries written before sendId existed, and anything that reaches the
 * backlog as a bare string, have no id. Those keep the old collapse-by-address
 * behaviour rather than being treated as all-distinct, so a campaign that is
 * mid-flight across a deploy does not change semantics underneath itself. Scoped by
 * sourceFile so two files are never confused.
 */
function resendIdentity(sendId, email, sourceFile) {
  if (typeof sendId === 'string' && sendId !== '') return `id:${sendId}`;
  return `email:${sourceFile || ''}#${email}`;
}

/**
 * Records recipients that were enqueued but never handed to a mail server.
 *
 * Entries are JSON so two things survive the round trip:
 *
 *   sourceFile — a multi-file campaign needs it to attribute the send to the right
 *                UploadedFile when it is eventually delivered.
 *   sendId     — the identity of this one send. See resendIdentity() for why the
 *                address cannot serve as the identity.
 *
 * LLEN is checked first so a runaway caller cannot grow this without bound. The
 * TTL is re-asserted on every append, matching how the log trail is handled, so a
 * backlog that is still being added to cannot expire underneath itself.
 */
async function queueForResend(redis, sessionId, entries) {
  if (!redis || !sessionId) return 0;

  const list = (Array.isArray(entries) ? entries : [entries])
    .map((entry) => {
      if (!entry) return null;
      if (typeof entry === 'string') return { email: entry, sourceFile: sessionId, sendId: '' };
      if (typeof entry.email !== 'string' || !entry.email) return null;
      return {
        email: entry.email,
        sourceFile: entry.sourceFile || sessionId,
        sendId: typeof entry.sendId === 'string' ? entry.sendId : ''
      };
    })
    .filter(Boolean);

  if (list.length === 0) return 0;

  const key = resendKey(sessionId);
  const existing = await redis.llen(key);
  if (existing >= RESEND_MAX_LENGTH) return 0;

  const room = RESEND_MAX_LENGTH - existing;
  const accepted = list.slice(0, room);

  await redis
    .pipeline()
    .rpush(key, ...accepted.map((entry) => JSON.stringify(entry)))
    .expire(key, sessionKeyTtlSeconds())
    .exec();

  return accepted.length;
}

/** How many recipients are waiting to be re-sent. O(1). */
async function resendQueueLength(redis, sessionId) {
  if (!redis || !sessionId) return 0;
  try {
    return await redis.llen(resendKey(sessionId));
  } catch {
    return 0;
  }
}

/**
 * Removes and returns up to `max` queued recipients.
 *
 * LRANGE + LTRIM inside a MULTI, so the read and the removal are one step. Four
 * web processes can serve concurrent submissions for the same campaign, and a
 * non-atomic read-then-trim would hand the same addresses to both — which is
 * precisely the duplicate delivery this list exists to prevent.
 */
async function takeResendQueue(redis, sessionId, max = RESEND_DRAIN_MAX) {
  if (!redis || !sessionId) return [];

  const count = Math.max(1, Math.min(Number(max) || RESEND_DRAIN_MAX, RESEND_DRAIN_MAX));
  const key = resendKey(sessionId);

  const results = await redis
    .multi()
    .lrange(key, 0, count - 1)
    .ltrim(key, count, -1)
    .exec();

  const [rangeErr, raw] = (results && results[0]) || [];
  if (rangeErr || !Array.isArray(raw)) return [];

  const seenSendIds = new Set();
  const entries = [];

  for (const item of raw) {
    let parsed;
    try {
      parsed = JSON.parse(item);
    } catch {
      // Tolerate a bare address, which is what a future or older writer might
      // leave. Dropping it would lose a recipient.
      parsed = { email: String(item || ''), sourceFile: sessionId };
    }

    const email = parsed && typeof parsed.email === 'string' ? parsed.email.trim() : '';
    if (!email) continue;

    const sourceFile = parsed.sourceFile || sessionId;
    const identity = resendIdentity(parsed.sendId, email, sourceFile);

    // Collapsed on the identity of the SEND, never on the address.
    //
    // The same address can legitimately be owed several emails — a recipient list
    // holds one entry per send, so stopping a campaign that owes bob@example.com
    // three emails must resume owing three. Keying this on the address collapsed
    // them to one and silently dropped two sends.
    //
    // A repeat of the same `sendId` is a different thing entirely: it means one
    // send got recorded twice, which happens if purgeStoppedCampaignJobs dies
    // between queueing a recipient and removing its job — the surviving job is then
    // declined by the worker's stop check and queued again. Both records describe
    // the same send, so the second is dropped and that recipient gets one email on
    // restart rather than two.
    if (seenSendIds.has(identity)) continue;
    seenSendIds.add(identity);

    entries.push({
      email,
      sourceFile,
      sendId: typeof parsed.sendId === 'string' ? parsed.sendId : ''
    });
  }

  return entries;
}

/** Discards the backlog. Used when a campaign's data is deleted outright. */
async function clearResendQueue(redis, sessionId) {
  if (!redis || !sessionId) return 0;
  return redis.del(resendKey(sessionId));
}

module.exports = {
  RESEND_DRAIN_MAX,
  RESEND_MAX_LENGTH,
  stopCampaign,
  readCampaignStop,
  isCampaignStopped,
  clearCampaignStop,
  queueForResend,
  resendQueueLength,
  takeResendQueue,
  clearResendQueue,
  resendIdentity
};
