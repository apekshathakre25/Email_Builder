/**
 * Shared email-send rate limiter.
 *
 * WHAT THIS ENFORCES
 * ------------------
 * "No more than `limit` email-send operations in any `intervalSeconds` window."
 *
 * This is a *rate*, not a batch size. With limit=35 / interval=5s the sender is
 * allowed 35 sends across 00:00–00:05, another 35 across 00:05–00:10, and so on,
 * and it keeps pulling work the whole time. It is deliberately NOT
 * "send 35 → sleep 5s → send 35": nothing here sleeps for a fixed batch
 * boundary, and a window that only manages 20 sends does not hold the next 15
 * back.
 *
 * WHY IT LIVES IN REDIS
 * ---------------------
 * Sending happens in workprocess/mailer.js, which runs as 14 independent PM2
 * fork processes by default (ecosystem.config.js), each with WORKER_CONCURRENCY
 * job slots — ~700 concurrent sends. A per-process counter would therefore
 * enforce 14× the configured rate. The bucket has to be one shared object, so it
 * is a Redis sorted set mutated by a single Lua script: one atomic
 * read-prune-decide-write per send, with no read/modify/write race between
 * workers.
 *
 * WHY A SLIDING WINDOW, NOT A FIXED ONE
 * -------------------------------------
 * A counter keyed on floor(now / interval) is cheaper, but it permits a double
 * burst across a boundary: 35 sends at 00:04.9 and 35 more at 00:05.1 is 70
 * sends inside 200ms while satisfying "35 per numbered window". The sorted set
 * holds one entry per send and prunes by age, so the limit holds over *every*
 * window position, which is the stricter reading of the requirement and the one
 * an SMTP provider actually cares about.
 *
 * WHY REDIS SUPPLIES THE CLOCK
 * ----------------------------
 * The script reads TIME rather than accepting a timestamp from the caller, so
 * the window is measured on one clock. Clock drift between worker hosts would
 * otherwise let a host that is running fast prune entries early and hand out
 * extra capacity.
 *
 * IT ALSO ENFORCES THE CAMPAIGN STOP
 * ----------------------------------
 * The acquire script refuses to grant a slot once `campaignstop:<scope>` exists
 * (see utils/campaignStop.js). Putting that check here, rather than in the worker
 * before calling in, is what removes the race: taking a slot and confirming the
 * campaign is still running become one indivisible Redis operation, so a stop
 * committed at any point cannot be overtaken by a send that was already deciding
 * to proceed. `waitForSlot` surfaces it as CampaignStoppedError.
 */

const logger = require('./logger');
const { campaignStopKey } = require('./sessionKeys');

// Namespace, so the buckets are recognisable in a keyspace shared with
// `recipients:*`, `sentIndex:*`, `emaillog:*` and Bull's own keys.
const KEY_PREFIX = 'ratelimit:emailsend:';

/**
 * Validation bounds. Exported because the browser validates against the same
 * numbers in public/js/recipents-upload.js — frontend validation is only there
 * to give a fast, readable error, and every value is re-checked here.
 */
const LIMIT_MIN = 1;
const LIMIT_MAX = 1000000;

/**
 * Interval bounds, in seconds.
 *
 * The ceiling is the load-bearing one. A worker that has run out of capacity
 * waits in-process for the next slot, and that wait cannot exceed one interval,
 * so the interval also bounds how long a job can occupy a Bull job slot and how
 * long a graceful shutdown may have to wait. One hour is generous for any real
 * provider quota while keeping that bound comprehensible.
 *
 * The floor is 0.1s rather than 1s because the requirement asks for a positive
 * number of seconds, not an integer count.
 */
const INTERVAL_SECONDS_MIN = 0.1;
const INTERVAL_SECONDS_MAX = 3600;

/**
 * Longest single uninterrupted sleep while waiting for capacity.
 *
 * The wait is sliced instead of being one `setTimeout(retryAfterMs)` so that
 * shutdown (and any future campaign-cancel flag) is noticed within a quarter of
 * a second instead of at the end of a potentially minutes-long interval.
 */
const WAIT_SLICE_MS = 250;

/**
 * Sliding-window acquire, as one atomic Lua script.
 *
 * Returns { allowed, used, retryAfterMs, atMs }:
 *   allowed      1 when this send may proceed and a slot has been consumed
 *                0 when the window is full
 *               -1 when the campaign has been stopped — no slot is consumed and
 *                  no further slot will ever be granted for this scope
 *   used         slots used in the current window, including this one when allowed
 *   retryAfterMs when denied, ms until the oldest entry ages out and frees a slot
 *   atMs         Redis' clock reading for this decision, and the score the entry
 *                was stored under. Returned so callers reason about the window on
 *                the same clock the limiter used, instead of their own.
 *
 * WHY THE STOP CHECK IS IN HERE
 * -----------------------------
 * This is the only place where "may this campaign send?" and "take a slot" can be
 * decided together. Checking the marker in Node before calling this would leave a
 * window — read "not stopped", operator commits the stop, then consume a slot and
 * send — and at ~700 concurrent senders that window is hit routinely, which is
 * exactly the "worker keeps sending after the UI says stopped" failure this must
 * not have.
 *
 * Redis executes a script to completion with nothing interleaved, so once
 * `campaignstop:<scope>` exists, every subsequent invocation returns -1. The stop
 * becomes effective the instant it is written, with no coordination and no lock.
 * A sender that already holds a slot finishes; nothing new is released.
 *
 * `member` is supplied by the caller because sorted-set members must be unique
 * and two sends can share a millisecond. Generating it in Lua would need
 * math.random, whose seed is not guaranteed to differ between script invocations.
 */
const ACQUIRE_SCRIPT = `
local key      = KEYS[1]
local stopKey  = KEYS[2]
local windowMs = tonumber(ARGV[1])
local limit    = tonumber(ARGV[2])
local member   = ARGV[3]

-- TIME is non-deterministic, so on Redis 4 and older it must be preceded by
-- replicate_commands() to switch the script to effects replication. Redis 5+
-- replicates effects by default and keeps this as a no-op, so the guard is
-- version-portable rather than conditional on a version check.
if redis.replicate_commands then
  pcall(redis.replicate_commands)
end

local t   = redis.call('TIME')
local now = (tonumber(t[1]) * 1000) + math.floor(tonumber(t[2]) / 1000)

-- Before anything else, and before any slot is consumed. A stopped campaign must
-- not even touch the bucket: consuming capacity for a send that will not happen
-- would throttle the campaign the operator starts next.
if redis.call('EXISTS', stopKey) == 1 then
  return { -1, 0, 0, now }
end

-- Anything at or beyond windowMs old is outside the window and no longer
-- occupies a slot. Pruning first is what makes this a sliding window.
redis.call('ZREMRANGEBYSCORE', key, '-inf', now - windowMs)

local used = redis.call('ZCARD', key)

if used < limit then
  redis.call('ZADD', key, now, member)
  -- Bucket is self-cleaning: one window of grace past the last send, so an
  -- abandoned campaign leaves nothing behind.
  redis.call('PEXPIRE', key, windowMs + 1000)
  return { 1, used + 1, 0, now }
end

-- At capacity. The next slot frees when the oldest entry leaves the window.
local retryAfterMs = windowMs
local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
if oldest[2] then
  retryAfterMs = (tonumber(oldest[2]) + windowMs) - now
  if retryAfterMs < 1 then
    retryAfterMs = 1
  end
end

redis.call('PEXPIRE', key, windowMs + 1000)
return { 0, used, retryAfterMs, now }
`;

/**
 * Read-only companion to ACQUIRE_SCRIPT: describes the window without touching it.
 *
 * Exists so /status can tell the operator when the next interval opens without
 * stealing a slot from a worker. It must not prune, because pruning is a write and
 * this is called from the web processes on a polling loop; it filters by score
 * instead, which yields the same answer as a pruned ZCARD would.
 *
 * Redis' own clock is used for the same reason the acquire script uses it: the web
 * hosts and the worker hosts can drift, and a countdown computed on a different
 * clock from the one enforcing the limit would visibly disagree with reality.
 */
const WINDOW_STATE_SCRIPT = `
local key      = KEYS[1]
local windowMs = tonumber(ARGV[1])

local t   = redis.call('TIME')
local now = (tonumber(t[1]) * 1000) + math.floor(tonumber(t[2]) / 1000)

local used = redis.call('ZCOUNT', key, now - windowMs, '+inf')

local resetInMs = 0
local oldest = redis.call('ZRANGEBYSCORE', key, now - windowMs, '+inf', 'WITHSCORES', 'LIMIT', 0, 1)
if oldest[2] then
  resetInMs = (tonumber(oldest[2]) + windowMs) - now
  if resetInMs < 0 then
    resetInMs = 0
  end
end

return { used, resetInMs, now }
`;

/** Marks a client whose custom commands are already registered. */
const COMMAND_DEFINED = Symbol('emailRateLimiterCommandDefined');
const COMMAND_NAME = 'emailRateLimitAcquire';
const WINDOW_COMMAND_NAME = 'emailRateLimitWindowState';

/**
 * Registers the scripts as ioredis custom commands, which sends EVALSHA and
 * falls back to EVAL only on NOSCRIPT. Without this the full script body would
 * travel on every send.
 */
function ensureCommand(redis) {
  if (redis[COMMAND_DEFINED]) return;

  if (typeof redis.defineCommand !== 'function') {
    throw new TypeError('emailRateLimiter requires an ioredis client (defineCommand is missing).');
  }

  // A second limiter over the same client must not redefine the command.
  if (typeof redis[COMMAND_NAME] !== 'function') {
    redis.defineCommand(COMMAND_NAME, { numberOfKeys: 2, lua: ACQUIRE_SCRIPT });
  }

  if (typeof redis[WINDOW_COMMAND_NAME] !== 'function') {
    redis.defineCommand(WINDOW_COMMAND_NAME, { numberOfKeys: 1, lua: WINDOW_STATE_SCRIPT });
  }

  redis[COMMAND_DEFINED] = true;
}

function bucketKey(scope) {
  return `${KEY_PREFIX}${scope}`;
}

/**
 * Turns raw form input into a usable config, or explains why it cannot.
 *
 * Returns { ok: true, config } where `config` is null when rate limiting is off,
 * or { ok: false, error } with a message safe to show the operator.
 *
 * BACKWARD COMPATIBILITY — the reason `config` can be null on success:
 * before this feature, `limit` meant "how many recipients this submission
 * takes" and there was no pacing at all. A campaign or saved draft that carries
 * no interval keeps exactly that behaviour: null config, no limiter, `limit`
 * still read as a batch size. Rate limiting only engages once the operator
 * supplies an interval, so nothing that worked before changes.
 */
function parseRateLimitConfig({ limit, intervalSeconds } = {}) {
  const limitRaw = limit === undefined || limit === null ? '' : String(limit).trim();
  const intervalRaw =
    intervalSeconds === undefined || intervalSeconds === null ? '' : String(intervalSeconds).trim();

  let parsedLimit = null;

  if (limitRaw !== '') {
    // Number() rather than parseInt(): parseInt('35abc') is 35 and parseInt('1e3')
    // is 1, so it would silently accept malformed input as a valid rate.
    const value = Number(limitRaw);

    if (!Number.isInteger(value)) {
      return { ok: false, error: `Limit must be a whole number (got "${limitRaw}").` };
    }
    if (value < LIMIT_MIN || value > LIMIT_MAX) {
      return {
        ok: false,
        error: `Limit must be between ${LIMIT_MIN} and ${LIMIT_MAX} (got ${value}).`
      };
    }

    parsedLimit = value;
  }

  if (intervalRaw === '') {
    // No window configured: legacy batch-size behaviour, limiter disabled.
    return { ok: true, config: null, parsedLimit };
  }

  const intervalValue = Number(intervalRaw);

  if (!Number.isFinite(intervalValue)) {
    return {
      ok: false,
      error: `Interval (seconds) must be a number (got "${intervalRaw}").`
    };
  }
  if (intervalValue < INTERVAL_SECONDS_MIN || intervalValue > INTERVAL_SECONDS_MAX) {
    return {
      ok: false,
      error:
        `Interval (seconds) must be between ${INTERVAL_SECONDS_MIN} and ` +
        `${INTERVAL_SECONDS_MAX} (got ${intervalValue}).`
    };
  }

  // An interval on its own has no meaning: the limit is the numerator of the rate.
  if (parsedLimit === null) {
    return {
      ok: false,
      error: 'Interval (seconds) needs a Limit — Limit is how many emails each interval allows.'
    };
  }

  return {
    ok: true,
    parsedLimit,
    config: {
      limit: parsedLimit,
      intervalSeconds: intervalValue,
      // Rounded up so a fractional interval can never produce a 0ms window,
      // which would divide by nothing and disable pruning.
      intervalMs: Math.max(1, Math.ceil(intervalValue * 1000))
    }
  };
}

/**
 * Re-validates a config that arrived on a Bull job.
 *
 * Jobs are read back from Redis and may have been enqueued by an older release,
 * so the worker cannot assume the shape is current or sane. Anything unusable is
 * treated as "no rate limit" instead of throwing: failing the job would lose the
 * recipient over a configuration problem, whereas sending unthrottled is what
 * this queue did before the feature existed.
 */
function normalizeJobRateLimit(raw, { onInvalid } = {}) {
  if (!raw || typeof raw !== 'object') return null;

  const limit = Number(raw.limit);
  const intervalMs = Number(raw.intervalMs);
  const scope = typeof raw.scope === 'string' ? raw.scope.trim() : '';

  const invalid =
    !Number.isInteger(limit) ||
    limit < LIMIT_MIN ||
    limit > LIMIT_MAX ||
    !Number.isFinite(intervalMs) ||
    intervalMs < 1 ||
    intervalMs > INTERVAL_SECONDS_MAX * 1000 ||
    !scope;

  if (invalid) {
    if (typeof onInvalid === 'function') onInvalid(raw);
    return null;
  }

  return { limit, intervalMs, scope };
}

/** Raised when a wait is abandoned rather than completed. */
class RateLimitWaitAbortedError extends Error {
  constructor(reason) {
    super(`Email send abandoned while waiting for a rate-limit slot: ${reason}`);
    this.name = 'RateLimitWaitAbortedError';
    this.reason = reason;
  }
}

/**
 * Raised when the campaign has been stopped, so this recipient must not be sent.
 *
 * Deliberately a distinct type rather than a variety of RateLimitWaitAbortedError.
 * The two need opposite handling downstream: an aborted wait is an anomaly worth
 * recording, whereas a stop is the operator getting exactly what they asked for,
 * and the recipient must be left pending rather than marked failed. Callers
 * discriminate on the class, not on message text.
 */
class CampaignStoppedError extends Error {
  constructor(scope) {
    super(`Campaign ${scope} has been stopped — this recipient was not sent and is still pending.`);
    this.name = 'CampaignStoppedError';
    this.scope = scope;
    this.campaignStopped = true;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Per-process log throttle.
 *
 * A throttled campaign would otherwise emit a line per blocked send — 700
 * concurrent slots against a 35/5s limit is thousands of lines per window, in a
 * codebase whose logger is deliberately quiet in production. One line per scope
 * per window keeps the signal ("this campaign is being paced, here is the
 * usage") without the volume.
 */
const lastThrottleLogAt = new Map();

function shouldLogThrottle(scope, intervalMs) {
  const now = Date.now();
  const previous = lastThrottleLogAt.get(scope);

  if (previous !== undefined && now - previous < intervalMs) return false;

  // Bounded so a process that serves many campaigns does not grow this forever.
  if (lastThrottleLogAt.size > 500) lastThrottleLogAt.clear();

  lastThrottleLogAt.set(scope, now);
  return true;
}

function createEmailRateLimiter(redis) {
  if (!redis) throw new TypeError('emailRateLimiter requires a Redis client.');

  let memberCounter = 0;

  function nextMember() {
    // Unique per send across processes: pid distinguishes workers on a host,
    // hrtime distinguishes sends within a millisecond, and the counter covers
    // two calls landing on the same hrtime reading.
    memberCounter = (memberCounter + 1) % Number.MAX_SAFE_INTEGER;
    return `${process.pid}-${process.hrtime.bigint()}-${memberCounter}`;
  }

  /**
   * Consumes one slot if the window has room. Never blocks, never throws for a
   * denial — a denial is a normal return value.
   */
  async function acquire(config) {
    const { limit, intervalMs, scope } = config;

    ensureCommand(redis);

    const [allowed, used, retryAfterMs, atMs] = await redis[COMMAND_NAME](
      bucketKey(scope),
      campaignStopKey(scope),
      intervalMs,
      limit,
      nextMember()
    );

    const verdict = Number(allowed);

    return {
      allowed: verdict === 1,
      // -1 is the script's stopped sentinel. Distinguished from a plain denial
      // because a denial is temporary and a stop is final: callers must stop
      // waiting rather than retry.
      stopped: verdict === -1,
      used: Number(used),
      limit,
      retryAfterMs: Number(retryAfterMs),
      atMs: Number(atMs)
    };
  }

  /**
   * Blocks until a slot is available, then consumes it.
   *
   * This is the call that makes the guarantee hold: it sits immediately before
   * the actual `transporter.sendMail`, so every send — first attempt or retry —
   * has to pass through it, and no send happens without a slot.
   *
   * `shouldAbort` is polled between slices and is how shutdown prevents queued
   * work from continuing to send. Return a truthy value to stop; a string is used
   * as the recorded reason.
   *
   * A campaign stop is NOT expressed through `shouldAbort`. It is checked inside
   * the acquire script instead, atomically with taking a slot, because a check in
   * this loop could only ever run *before* the acquire and would leave a window
   * in which the stop lands and a slot is still handed out. When the script
   * reports the stop this throws CampaignStoppedError immediately — waiting for
   * capacity on a campaign that will never be allowed to send again is pointless,
   * and it would hold a Bull job slot for a whole interval for nothing.
   */
  async function waitForSlot(config, { shouldAbort, maxWaitMs } = {}) {
    const startedAt = Date.now();
    const { scope, intervalMs } = config;

    // One interval is the theoretical maximum wait for a single slot. The
    // allowance is larger because many workers can be queued behind the same
    // bucket and lose races to it; the ceiling exists only so a misconfiguration
    // surfaces as a failed job instead of a permanently parked one.
    const budgetMs =
      Number.isFinite(maxWaitMs) && maxWaitMs > 0
        ? maxWaitMs
        : Math.max(intervalMs * 4, 60000);

    let waitedMs = 0;
    let logged = false;

    for (;;) {
      const abort = typeof shouldAbort === 'function' ? shouldAbort() : false;
      if (abort) {
        throw new RateLimitWaitAbortedError(typeof abort === 'string' ? abort : 'cancelled');
      }

      const outcome = await acquire(config);

      if (outcome.stopped) {
        throw new CampaignStoppedError(scope);
      }

      if (outcome.allowed) {
        if (logged) {
          logger.force(
            `▶️  Rate limit slot granted for ${scope} after ${waitedMs}ms wait ` +
            `(window usage ${outcome.used}/${outcome.limit}).`
          );
        }
        return { ...outcome, waitedMs };
      }

      if (!logged && shouldLogThrottle(scope, intervalMs)) {
        logger.force(
          `⏳ Rate limit reached for ${scope}: window usage ${outcome.used}/${outcome.limit}. ` +
          `Next send allowed in ${Math.ceil(outcome.retryAfterMs / 1000)}s — holding, not dropping.`
        );
        logged = true;
      }

      if (Date.now() - startedAt >= budgetMs) {
        throw new RateLimitWaitAbortedError(
          `no slot became available within ${budgetMs}ms (limit ${outcome.limit} per ` +
          `${intervalMs}ms, window usage ${outcome.used})`
        );
      }

      // Sliced so `shouldAbort` is re-checked promptly, and never so long that
      // the wait overshoots the moment capacity actually frees.
      const slice = Math.max(1, Math.min(WAIT_SLICE_MS, outcome.retryAfterMs));
      await sleep(slice);
      waitedMs = Date.now() - startedAt;
    }
  }

  /** Current window usage, for tests and diagnostics. Consumes nothing. */
  async function usage(scope, intervalMs) {
    const key = bucketKey(scope);
    const now = Date.now();
    await redis.zremrangebyscore(key, '-inf', now - intervalMs);
    return redis.zcard(key);
  }

  /**
   * Describes the current window for display. Consumes nothing and writes nothing.
   *
   * `resetInMs` is the countdown the operator sees as "Next interval": the time
   * until the oldest send in the window ages out and capacity frees. It is 0 when
   * the window is empty, which reads as "sending now" rather than "waiting".
   *
   * Safe to call for a scope that has never sent — an absent key yields
   * { used: 0, resetInMs: 0 }.
   */
  async function windowState(scope, intervalMs) {
    ensureCommand(redis);

    const [used, resetInMs, atMs] = await redis[WINDOW_COMMAND_NAME](
      bucketKey(scope),
      intervalMs
    );

    return {
      used: Number(used) || 0,
      resetInMs: Math.max(0, Number(resetInMs) || 0),
      atMs: Number(atMs) || Date.now()
    };
  }

  /** Drops a bucket. Used by tests; buckets otherwise expire on their own. */
  async function reset(scope) {
    return redis.del(bucketKey(scope));
  }

  return { acquire, waitForSlot, usage, windowState, reset };
}

module.exports = {
  createEmailRateLimiter,
  parseRateLimitConfig,
  normalizeJobRateLimit,
  RateLimitWaitAbortedError,
  CampaignStoppedError,
  bucketKey,
  KEY_PREFIX,
  LIMIT_MIN,
  LIMIT_MAX,
  INTERVAL_SECONDS_MIN,
  INTERVAL_SECONDS_MAX
};
