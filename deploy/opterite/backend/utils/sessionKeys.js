/**
 * Lifecycle for the per-session Redis keys.
 *
 * Six keys are scoped to a session id (a recipient file id for bulk campaigns,
 * or a `test-<timestamp>` id for test sends):
 *
 *   recipients:<id>   LIST   validated addresses, written once at upload
 *   sentIndex:<id>    STRING resume position, rewritten per enqueued batch
 *   emaillog:<id>     LIST   the worker's append-only per-send trail
 *   emailstats:<id>   HASH   live `sent`/`failed` tallies for that same trail
 *   campaignstop:<id> STRING the operator's stop marker — see utils/campaignStop.js
 *   resend:<id>       LIST   recipients enqueued but never attempted, kept for the
 *                            next send so a stop cannot lose them
 *
 * `emailstats` exists because the UI cannot wait for MongoDB. Worker outcomes
 * reach MongoDB through BatchLogger, which buffers in process memory and flushes
 * on a 2s timer, per worker process — so `EmailLog.sentCount` moves in steps and
 * lags the actual sends. These two fields are incremented in the same pipeline
 * that appends to `emaillog:<id>`, once per email, so /status can report a live
 * count at O(1) instead of a batched one. MongoDB remains the durable record.
 *
 * It is paired with `emaillog` throughout: same TTL, dropped together, adopted
 * together. A tally that outlived its trail, or vice versa, would be a number
 * nobody could audit against the log.
 *
 * None of them had an expiry, so any key whose MongoDB row was removed outside
 * the retention sweep — a file deleted from the UI, or a test send, which never
 * creates a file row at all — stayed in Redis forever.
 *
 * Three mechanisms now cover them, in order of preference:
 *
 *   1. Explicit deletion when the owning record is deleted (UI delete routes and
 *      the retention sweep). Precise, immediate, and the normal path.
 *   2. A sliding TTL, so a key that escapes (1) still goes away on its own. It is
 *      refreshed whenever the session is actually used, which is what keeps a
 *      long-running campaign safe.
 *   3. Adoption of pre-existing persistent keys, so keys written before any of
 *      this existed are brought under the TTL instead of living forever.
 *
 * The TTL is deliberately a multiple of DB_CLEANUP_DAYS rather than equal to it.
 * Redis must always be the *last* copy to disappear: if these keys expired on
 * the same schedule as the MongoDB rows, a recipient list could vanish while its
 * `uploaded` file row — which the sweep deliberately preserves as pending work —
 * was still listed in the UI, and sending it would fail with "no valid
 * recipients". At the default 3 days the backstop is 12 days of inactivity.
 *
 * DB_CLEANUP_DAYS remains the single retention knob; this derives from it.
 */

const env = require('../config/env');

// Matches the abandonment threshold used for in-progress campaigns in
// utils/dbCleanup.js. Same intent: "untouched for this long means nobody is
// coming back for it."
const RETENTION_MULTIPLIER = 4;

const EMAIL_LOG_PREFIX = 'emaillog';
const EMAIL_STATS_PREFIX = 'emailstats';

/**
 * Stop state and its companion resend backlog.
 *
 * Defined here rather than in utils/campaignStop.js so that every mechanism in
 * this file — the sliding TTL, the explicit drop when a file is deleted, and the
 * adoption sweep for keys written without an expiry — covers them automatically.
 * campaignStop.js imports these; the dependency deliberately runs one way.
 *
 * Dropping the stop marker alongside the rest of the session is the load-bearing
 * part. A bulk session id *is* the recipient file's id, so a stop marker that
 * outlived its file would silently refuse to send the next campaign that reused
 * that id.
 */
const CAMPAIGN_STOP_PREFIX = 'campaignstop';
const RESEND_PREFIX = 'resend';

const PREFIXES = [
  'recipients',
  'sentIndex',
  EMAIL_LOG_PREFIX,
  EMAIL_STATS_PREFIX,
  CAMPAIGN_STOP_PREFIX,
  RESEND_PREFIX
];

function sessionKeyTtlSeconds() {
  return env.dbCleanup.retentionSeconds * RETENTION_MULTIPLIER;
}

function recipientsKey(sessionId) {
  return `recipients:${sessionId}`;
}

function sentIndexKey(sessionId) {
  return `sentIndex:${sessionId}`;
}

function emailLogKey(sessionId) {
  return `${EMAIL_LOG_PREFIX}:${sessionId}`;
}

function emailStatsKey(sessionId) {
  return `${EMAIL_STATS_PREFIX}:${sessionId}`;
}

function campaignStopKey(sessionId) {
  return `${CAMPAIGN_STOP_PREFIX}:${sessionId}`;
}

function resendKey(sessionId) {
  return `${RESEND_PREFIX}:${sessionId}`;
}

/**
 * The stats key paired with an already-resolved `emaillog:<id>` key.
 *
 * The worker derives it this way rather than from `job.data.sessionId` on
 * purpose. `logKey` is the value that has already been resolved through the
 * campaign config for this particular job, so deriving from it makes the tally
 * and the trail structurally incapable of pointing at different sessions.
 *
 * Returns null for anything that is not an email-log key, which is what makes the
 * worker's guard against a missing or malformed `logKey` work.
 */
function emailStatsKeyForLogKey(logKey) {
  const prefix = `${EMAIL_LOG_PREFIX}:`;
  if (typeof logKey !== 'string' || !logKey.startsWith(prefix)) return null;

  const sessionId = logKey.slice(prefix.length);
  if (!sessionId) return null;

  return emailStatsKey(sessionId);
}

function allSessionKeys(sessionId) {
  return [
    recipientsKey(sessionId),
    sentIndexKey(sessionId),
    emailLogKey(sessionId),
    emailStatsKey(sessionId),
    campaignStopKey(sessionId),
    resendKey(sessionId)
  ];
}

/**
 * Restarts the TTL clock on a session's keys.
 *
 * Called when a session is actively used, so an active campaign can never expire
 * mid-flight however long it runs. EXPIRE on a missing key is a no-op returning
 * 0, so this is safe to call for a session that has only some of the three.
 * Pipelined into a single round trip.
 */
async function touchSessionKeys(redis, sessionId) {
  if (!redis || !sessionId) return;

  const ttl = sessionKeyTtlSeconds();
  const pipeline = redis.pipeline();

  for (const key of allSessionKeys(sessionId)) {
    pipeline.expire(key, ttl);
  }

  await pipeline.exec();
}

/**
 * Removes a session's keys outright. Returns how many existed.
 *
 * Used when the owning record is deleted for good, so the keys go at the same
 * moment rather than lingering until the TTL.
 */
async function dropSessionKeys(redis, sessionId) {
  if (!redis || !sessionId) return 0;
  return redis.del(...allSessionKeys(sessionId));
}

/**
 * Deletes only the worker's log trail for a session, and its tally.
 *
 * Deleting a campaign log must not touch `recipients:` or `sentIndex:`, which
 * belong to the recipient file rather than the log: dropping the recipient list
 * would break a file that is still listed, and resetting the sent index would
 * make a later send start from zero and re-deliver to everyone.
 *
 * `emailstats:` does go, because it is a summary of the trail being deleted.
 * Leaving it behind would let /status keep serving live counts for a log the
 * operator just cleared.
 */
async function dropEmailLogKey(redis, sessionId) {
  if (!redis || !sessionId) return 0;
  return redis.del(emailLogKey(sessionId), emailStatsKey(sessionId));
}

/**
 * Initialises a session's live tally from the durable counters, once.
 *
 * Called at enqueue time. Without it, a campaign that was part-way through when
 * this feature was deployed — or whose tally expired while its MongoDB row
 * survived — would start counting again from zero and /status would report a
 * sharp drop in "Sent".
 *
 * HSETNX, so it can only ever seed a field that does not exist yet: a tally that
 * is already live is left strictly alone, and a concurrent worker HINCRBY on the
 * same field always wins. /status additionally takes the larger of the Redis and
 * MongoDB counts, which is what makes the remaining race — a worker incrementing
 * a fresh field between this call and the first read — unable to under-report.
 */
async function seedEmailStats(redis, sessionId, { sent = 0, failed = 0 } = {}) {
  if (!redis || !sessionId) return;

  const key = emailStatsKey(sessionId);

  await redis
    .pipeline()
    .hsetnx(key, 'sent', String(Math.max(0, Math.trunc(sent) || 0)))
    .hsetnx(key, 'failed', String(Math.max(0, Math.trunc(failed) || 0)))
    .expire(key, sessionKeyTtlSeconds())
    .exec();
}

/**
 * Reads a session's live tally, or null when it has none.
 *
 * Null is meaningful and must be distinguished from a genuine zero: it means
 * "Redis has nothing to say about this session", which is the signal for /status
 * to fall back to the MongoDB counters instead of reporting 0 sent for a campaign
 * that has been running for an hour.
 */
async function readEmailStats(redis, sessionId) {
  if (!redis || !sessionId) return null;

  const [sent, failed] = await redis.hmget(emailStatsKey(sessionId), 'sent', 'failed');
  if (sent === null && failed === null) return null;

  const toCount = (raw) => {
    const parsed = parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  };

  return { sent: toCount(sent), failed: toCount(failed) };
}

/**
 * Brings persistent (TTL-less) session keys under the TTL.
 *
 * Two populations need this: keys written before the TTL existed, and any key a
 * future code path creates without one. Nothing is deleted here — an expiry is
 * applied and the normal sliding refresh still protects anything in use, so an
 * active campaign is unaffected even if its keys are adopted mid-send.
 *
 * SCAN, never KEYS: KEYS blocks the single-threaded server for the whole keyspace,
 * which on this deployment shares Redis with the Bull queue and the rate limiter.
 * Bounded by `maxKeys` so one run cannot walk an enormous keyspace.
 */
async function adoptPersistentSessionKeys(redis, { scanCount = 500, maxKeys = 50000 } = {}) {
  const ttl = sessionKeyTtlSeconds();

  let scanned = 0;
  let adopted = 0;
  let capped = false;

  for (const prefix of PREFIXES) {
    let cursor = '0';

    do {
      const [nextCursor, keys] = await redis.scan(
        cursor,
        'MATCH',
        `${prefix}:*`,
        'COUNT',
        scanCount
      );
      cursor = nextCursor;

      if (keys.length > 0) {
        scanned += keys.length;

        // One round trip to read every TTL in this page.
        const ttlPipeline = redis.pipeline();
        for (const key of keys) ttlPipeline.pttl(key);
        const ttlResults = await ttlPipeline.exec();

        // -1 means the key exists with no expiry. -2 means it is already gone,
        // which is normal in a live keyspace and must not be given a TTL.
        const persistent = keys.filter((key, i) => {
          const [err, value] = ttlResults[i] || [];
          return !err && value === -1;
        });

        if (persistent.length > 0) {
          const expirePipeline = redis.pipeline();
          for (const key of persistent) expirePipeline.expire(key, ttl);
          await expirePipeline.exec();
          adopted += persistent.length;
        }
      }

      if (scanned >= maxKeys) {
        capped = true;
        break;
      }
    } while (cursor !== '0');

    if (capped) break;
  }

  return { scanned, adopted, capped, ttlSeconds: ttl };
}

/**
 * Deletes every `emaillog:*` and `emailstats:*` key. Used when all campaign logs
 * are deleted.
 *
 * Scoped to those two prefixes on purpose: recipient lists and sent indexes
 * survive, because deleting the logs must not disturb the files or their resume
 * position. The tallies go with the trails they summarise.
 */
async function dropAllEmailLogKeys(redis, { scanCount = 500 } = {}) {
  let deleted = 0;

  for (const prefix of [EMAIL_LOG_PREFIX, EMAIL_STATS_PREFIX]) {
    let cursor = '0';

    do {
      const [nextCursor, keys] = await redis.scan(
        cursor,
        'MATCH',
        `${prefix}:*`,
        'COUNT',
        scanCount
      );
      cursor = nextCursor;

      if (keys.length > 0) {
        deleted += await redis.del(...keys);
      }
    } while (cursor !== '0');
  }

  return deleted;
}

module.exports = {
  RETENTION_MULTIPLIER,
  CAMPAIGN_STOP_PREFIX,
  RESEND_PREFIX,
  sessionKeyTtlSeconds,
  recipientsKey,
  sentIndexKey,
  emailLogKey,
  emailStatsKey,
  campaignStopKey,
  resendKey,
  emailStatsKeyForLogKey,
  allSessionKeys,
  touchSessionKeys,
  dropSessionKeys,
  dropEmailLogKey,
  seedEmailStats,
  readEmailStats,
  adoptPersistentSessionKeys,
  dropAllEmailLogKeys
};
