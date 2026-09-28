/**
 * Automatic retention sweep for disposable MongoDB data.
 *
 * WHAT THIS DELETES, and why each one is safe:
 *
 *   emaillogentries  — one document per recipient per send. The largest
 *                      collection by far and pure history: every route that
 *                      reads it (log download, sent/failed/pending exports) is
 *                      a report on a finished campaign.
 *   emaillogs        — campaign summaries. Same reasoning, but skipped while
 *                      `in_progress`, because the worker's BatchLogger is still
 *                      $inc-ing the counters and /status is still reading them.
 *   imaptestresults  — inbox-placement tests. Already treated as throwaway by
 *                      the send path, which deletes a user's finished results
 *                      whenever they start a new test run. Normally expired by
 *                      the TTL index; swept here too so retention still holds
 *                      if the index is missing.
 *   uploadedfiles    — spent recipient lists, only once `completed` or `failed`.
 *
 * WHAT THIS NEVER TOUCHES:
 *
 *   emailconfigs, testemailaccounts, imapcredentials — operator configuration,
 *   at most one document per authorized user, read on every page load and at
 *   send time. Age says nothing about whether it is still needed: an operator
 *   who saved SMTP settings a month ago and comes back today must still find
 *   them. There is no code path here that can reach these collections.
 *
 * DESIGN NOTES:
 *
 *   - Deletes run in bounded batches with a pause between them, so a large
 *     backlog drains over several runs instead of holding the database in one
 *     enormous deleteMany.
 *   - Every filter is age-based AND state-based. Nothing is deleted purely
 *     because it is old; a document belonging to a running campaign is retained
 *     no matter how old it is.
 *   - Only one process sweeps at a time. PM2 runs the web app in cluster mode
 *     (4 instances by default), so the schedule is coordinated through a Redis
 *     lock, the same way login OTPs and rate-limit counters are shared.
 *   - A failure is logged and swallowed. Cleanup is housekeeping; it must never
 *     take the application down with it.
 */

const crypto = require('crypto');
const fs = require('fs/promises');
const mongoose = require('mongoose');

const env = require('../config/env');
const logger = require('./logger');
const { getSharedRedisClient } = require('../config/redis');
const { dropSessionKeys, adoptPersistentSessionKeys } = require('./sessionKeys');

const EmailLog = require('../models/EmailLog');
const EmailLogEntry = require('../models/EmailLogEntry');
const ImapTestResult = require('../models/ImapTestResult');
const UploadedFile = require('../models/UploadedFile');

const LOCK_KEY = 'dbcleanup:lock';
const LAST_RUN_KEY = 'dbcleanup:lastRunAt';

// Long enough to cover a capped run, short enough that a hard-killed process
// does not block cleanup for long. Renewed while a run is in progress.
const LOCK_TTL_MS = 10 * 60 * 1000;
const LOCK_RENEW_INTERVAL_MS = 2 * 60 * 1000;

// Breathing room between batches so a sweep interleaves with production traffic
// rather than monopolising the connection pool.
const BATCH_PAUSE_MS = 50;

// Delay before the first sweep after boot, so startup (index builds, warm-up,
// PM2 rolling reload) finishes first.
const BOOT_GRACE_MS = 60 * 1000;

// An in_progress campaign whose worker died is never marked complete, so its id
// would be excluded forever. Past this age the log is treated as abandoned and
// becomes eligible, which stops one crashed campaign from pinning its entries
// in the database permanently.
const STALE_IN_PROGRESS_MULTIPLIER = 4;

let scheduleTimer = null;
let running = false;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function cutoffDate() {
  return new Date(Date.now() - env.dbCleanup.retentionMs);
}

/**
 * The age past which an `in_progress` campaign is treated as abandoned rather
 * than live. Single source for both the protection list and the EmailLog filter,
 * so the summary row and its entries can never disagree about whether a campaign
 * is still running.
 */
function staleInProgressDate() {
  return new Date(Date.now() - env.dbCleanup.retentionMs * STALE_IN_PROGRESS_MULTIPLIER);
}

/**
 * Session ids that must be preserved regardless of age.
 *
 * A campaign is protected while its EmailLog is `in_progress` or `stopped`. Bulk
 * campaigns reuse the recipient file's id as the campaign session id, so a single
 * id can appear as EmailLog.sessionId, EmailLogEntry.sessionId,
 * EmailLogEntry.campaignId and UploadedFile.sessionId — one list covers all four.
 *
 * `stopped` is included for the same reason `in_progress` is: the operator halted
 * the campaign part-way, so its recipient list and resume position are still live
 * work they can come back to. Sweeping those away would leave a stopped campaign
 * that can never be finished — and because a stopped campaign keeps its pending
 * recipients in `resend:<id>`, deleting the session's Redis keys would discard
 * exactly the addresses that were never contacted.
 *
 * Logs that have been stuck in either state for several retention periods are
 * excluded from protection: see STALE_IN_PROGRESS_MULTIPLIER.
 */
async function findProtectedSessionIds() {
  const ids = await EmailLog.distinct('sessionId', {
    status: { $in: ['in_progress', 'stopped'] },
    createdAt: { $gte: staleInProgressDate() }
  });

  return ids.filter((id) => typeof id === 'string' && id.length > 0);
}

/**
 * Deletes documents matching `filter` in batches.
 *
 * Selects a page of _ids and deletes exactly those, rather than issuing one
 * unbounded deleteMany. Documents are not sorted: ordering is irrelevant for
 * deletion, and an explicit sort would force the planner off the index that
 * serves the filter.
 */
async function deleteInBatches(model, filter, label) {
  const { batchSize, maxDeletesPerRun } = env.dbCleanup;

  let deleted = 0;
  let batches = 0;
  let capped = false;

  for (;;) {
    const remaining = maxDeletesPerRun - deleted;
    if (remaining <= 0) {
      capped = true;
      break;
    }

    const page = await model
      .find(filter)
      .select('_id')
      .limit(Math.min(batchSize, remaining))
      .lean();

    if (page.length === 0) break;

    const result = await model.deleteMany({ _id: { $in: page.map((doc) => doc._id) } });
    deleted += result.deletedCount || 0;
    batches += 1;

    // A short page means the filter is exhausted; stop before paying for
    // another query that we already know returns nothing.
    if (page.length < Math.min(batchSize, remaining)) break;

    await sleep(BATCH_PAUSE_MS);
  }

  return { collection: label, deleted, batches, capped };
}

/**
 * Per-recipient send outcomes.
 *
 * Excluded on both id fields because a bulk entry carries the campaign id in
 * `campaignId` and the source file id in `sessionId`, and those differ for
 * multi-file campaigns.
 */
function cleanupEmailLogEntries(cutoff, protectedIds) {
  const filter = { time: { $lt: cutoff } };

  if (protectedIds.length > 0) {
    filter.campaignId = { $nin: protectedIds };
    filter.sessionId = { $nin: protectedIds };
  }

  return deleteInBatches(EmailLogEntry, filter, 'emaillogentries');
}

/**
 * Campaign summaries.
 *
 * Two eligibility rules, matching how the entries are treated:
 *   - a settled campaign (completed/failed) goes once it is past the cutoff;
 *   - an `in_progress` campaign is protected until it is past the much longer
 *     abandonment threshold, then goes too.
 *
 * The second rule matters because a campaign whose worker died is never marked
 * complete. Guarding on `status` alone would keep that summary row forever while
 * its entries were cleaned, leaving a permanently "in progress" campaign in
 * /logs with nothing behind it.
 *
 * The id exclusion is still applied on top, so a campaign that flipped to
 * in_progress after the protection snapshot survives this run either way.
 *
 * `stopped` campaigns match the first rule, but findProtectedSessionIds() excludes
 * them until they pass the same abandonment threshold as a stuck in_progress one.
 * So a campaign the operator halted is retained for the full stale window — long
 * enough to come back and send the remaining recipients — and only then swept.
 */
function cleanupEmailLogs(cutoff, staleBefore, protectedIds) {
  const filter = {
    $or: [
      { status: { $ne: 'in_progress' }, createdAt: { $lt: cutoff } },
      { status: 'in_progress', createdAt: { $lt: staleBefore } }
    ]
  };

  if (protectedIds.length > 0) {
    filter.sessionId = { $nin: protectedIds };
  }

  return deleteInBatches(EmailLog, filter, 'emaillogs');
}

/**
 * Inbox-placement tests. Redundant with the TTL index under normal operation,
 * and deliberately so: retention must not silently lapse if the index could not
 * be created.
 */
function cleanupImapTestResults(cutoff) {
  return deleteInBatches(ImapTestResult, { createdAt: { $lt: cutoff } }, 'imaptestresults');
}

/**
 * Spent recipient lists.
 *
 * Handled separately from the generic batcher because the document is not the
 * only artefact: the parsed list lives in Redis and the original upload lives on
 * disk. Deleting just the row would shrink MongoDB while orphaning both.
 *
 * Only `completed` and `failed` files qualify. `uploaded` means the operator
 * staged a list and has not sent it yet — that is pending work, not garbage, and
 * `processing` is actively being consumed by the workers.
 */
async function cleanupUploadedFiles(cutoff, protectedIds) {
  const { batchSize, maxDeletesPerRun } = env.dbCleanup;
  const redis = getSharedRedisClient();

  const filter = {
    uploadDate: { $lt: cutoff },
    status: { $in: ['completed', 'failed'] }
  };

  if (protectedIds.length > 0) {
    filter.sessionId = { $nin: protectedIds };
  }

  let deleted = 0;
  let batches = 0;
  let filesUnlinked = 0;
  let redisKeysDropped = 0;
  let capped = false;

  for (;;) {
    const remaining = maxDeletesPerRun - deleted;
    if (remaining <= 0) {
      capped = true;
      break;
    }

    const pageSize = Math.min(batchSize, remaining);

    const page = await UploadedFile.find(filter)
      .select('_id sessionId storedPath')
      .limit(pageSize)
      .lean();

    if (page.length === 0) break;

    for (const doc of page) {
      if (doc.storedPath) {
        try {
          await fs.unlink(doc.storedPath);
          filesUnlinked += 1;
        } catch (err) {
          // Already gone is the expected case for anything deleted through the
          // UI, which unlinks the file itself. Anything else is worth seeing.
          if (err.code !== 'ENOENT') {
            logger.warn(`⚠️  Cleanup: could not unlink ${doc.storedPath}: ${err.message}`);
          }
        }
      }

      if (doc.sessionId) {
        try {
          // recipients / sentIndex drive resend position; emaillog is the
          // worker's append-only Redis trail. All three are scoped to this
          // session and none outlive the file, so they go now rather than
          // waiting out their TTL.
          redisKeysDropped += await dropSessionKeys(redis, doc.sessionId);
        } catch (err) {
          logger.warn(`⚠️  Cleanup: could not drop Redis keys for ${doc.sessionId}: ${err.message}`);
        }
      }
    }

    const result = await UploadedFile.deleteMany({ _id: { $in: page.map((doc) => doc._id) } });
    deleted += result.deletedCount || 0;
    batches += 1;

    if (page.length < pageSize) break;

    await sleep(BATCH_PAUSE_MS);
  }

  return {
    collection: 'uploadedfiles',
    deleted,
    batches,
    capped,
    filesUnlinked,
    redisKeysDropped
  };
}

/**
 * Brings the TTL index in line with the configured retention.
 *
 * MongoDB rejects createIndex on an existing key pattern whose options differ,
 * so a changed DB_CLEANUP_DAYS cannot take effect through Mongoose's own index
 * creation — it needs collMod. This runs on boot, which is what makes editing
 * .env and restarting actually change the expiry.
 *
 * Failure is not fatal. The sweep covers the same collection by age, so the
 * retention policy still holds; only the database-side automation is lost.
 */
async function reconcileTtlIndex() {
  const target = env.dbCleanup.retentionSeconds;
  const collection = ImapTestResult.collection;
  const indexName = ImapTestResult.TTL_INDEX_NAME;

  try {
    const indexes = await collection.indexes();
    const existing = indexes.find((index) => index.name === indexName);

    if (!existing) {
      await collection.createIndex({ createdAt: 1 }, { name: indexName, expireAfterSeconds: target });
      logger.force(`🧹 Cleanup: created TTL index ${indexName} on imaptestresults (${target}s)`);
      return;
    }

    if (existing.expireAfterSeconds === target) {
      logger.force(`🧹 Cleanup: TTL index ${indexName} already set to ${target}s`);
      return;
    }

    await mongoose.connection.db.command({
      collMod: collection.collectionName,
      index: { name: indexName, expireAfterSeconds: target }
    });

    logger.force(
      `🧹 Cleanup: TTL index ${indexName} expiry updated ${existing.expireAfterSeconds}s → ${target}s`
    );
  } catch (err) {
    logger.warn(
      `⚠️  Cleanup: could not reconcile TTL index on imaptestresults (${err.message}). ` +
      'The periodic sweep still enforces retention for this collection.'
    );
  }
}

// Returns a token on success, null when another instance holds the lock or Redis
// is unreachable. A Redis outage must degrade to "skip this run", not throw out
// of the scheduler: cleanup is housekeeping and the next interval will retry.
async function acquireLock(redis) {
  const token = crypto.randomBytes(16).toString('hex');

  try {
    const acquired = await redis.set(LOCK_KEY, token, 'PX', LOCK_TTL_MS, 'NX');
    return acquired === 'OK' ? token : null;
  } catch (err) {
    logger.warn(`⚠️  Cleanup: could not acquire lock (${err.message}); skipping this run`);
    return null;
  }
}

// Compare-and-delete, so a run that overshot its lock cannot release a lock that
// another instance has since taken.
async function releaseLock(redis, token) {
  const script =
    'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end';

  try {
    await redis.eval(script, 1, LOCK_KEY, token);
  } catch (err) {
    logger.warn(`⚠️  Cleanup: could not release lock: ${err.message}`);
  }
}

// Same compare-and-set discipline as the release, so a stale owner cannot extend
// somebody else's lock.
async function renewLock(redis, token) {
  const script =
    'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("pexpire", KEYS[1], ARGV[2]) else return 0 end';

  try {
    await redis.eval(script, 1, LOCK_KEY, token, String(LOCK_TTL_MS));
  } catch (err) {
    logger.warn(`⚠️  Cleanup: could not renew lock: ${err.message}`);
  }
}

/**
 * True when the interval has elapsed since the last completed sweep, according
 * to the timestamp shared by every instance.
 *
 * The lock alone is not enough to make the schedule global: it only stops
 * sweeps from overlapping. Four cluster instances each hold their own timer, so
 * without this check they would take the lock one after another and sweep four
 * times per interval — the second and subsequent runs finding nothing but still
 * issuing the queries. Checked after the lock is held, so the read cannot race
 * another instance writing it.
 *
 * The 10% tolerance absorbs timer jitter, so a run is not deferred a whole
 * interval for firing a few milliseconds early.
 */
async function isSweepDue(redis) {
  try {
    const raw = await redis.get(LAST_RUN_KEY);
    const lastRunAt = Number(raw);

    if (!raw || !Number.isFinite(lastRunAt) || lastRunAt <= 0) return true;

    return Date.now() - lastRunAt >= env.dbCleanup.intervalMs * 0.9;
  } catch (err) {
    // Unknown beats never: a Redis read failure should not suspend cleanup.
    logger.warn(`⚠️  Cleanup: could not read last-run timestamp (${err.message}); proceeding`);
    return true;
  }
}

/**
 * Runs one sweep, if this process can take the lock and the database is ready.
 * Resolves to a summary, or null when the run was skipped.
 *
 * `force` bypasses the interval check for an explicitly requested run; the
 * scheduler never sets it.
 */
async function runCleanup(trigger = 'manual', { force = false } = {}) {
  if (!env.dbCleanup.enabled) return null;

  if (running) {
    logger.warn('⚠️  Cleanup: previous run still active, skipping this trigger');
    return null;
  }

  if (mongoose.connection.readyState !== 1) {
    logger.warn('⚠️  Cleanup: MongoDB not connected, skipping this run');
    return null;
  }

  const redis = getSharedRedisClient();
  const token = await acquireLock(redis);

  if (!token) {
    // Expected whenever cluster instances fire at the same moment.
    logger.force('🧹 Cleanup: another instance holds the lock, skipping');
    return null;
  }

  if (!force && !(await isSweepDue(redis))) {
    logger.force('🧹 Cleanup: another instance already swept within this interval, skipping');
    await releaseLock(redis, token);
    return null;
  }

  running = true;
  const startedAt = Date.now();
  const cutoff = cutoffDate();
  const staleBefore = staleInProgressDate();

  const renewTimer = setInterval(() => renewLock(redis, token), LOCK_RENEW_INTERVAL_MS);
  if (typeof renewTimer.unref === 'function') renewTimer.unref();

  logger.force(
    `🧹 Cleanup started (trigger: ${trigger}) — retention ${env.dbCleanup.retentionDays} day(s), ` +
    `deleting records older than ${cutoff.toISOString()}`
  );

  const results = [];
  let redisAdoption = null;
  let failed = false;

  try {
    const protectedIds = await findProtectedSessionIds();

    if (protectedIds.length > 0) {
      logger.force(
        `🧹 Cleanup: preserving ${protectedIds.length} in-progress campaign(s) regardless of age`
      );
    }

    // Entries first: they are the bulk of the volume, and doing them before the
    // parent logs means a capped run never leaves entries whose campaign summary
    // is already gone.
    results.push(await cleanupEmailLogEntries(cutoff, protectedIds));
    results.push(await cleanupEmailLogs(cutoff, staleBefore, protectedIds));
    results.push(await cleanupImapTestResults(cutoff));

    if (env.dbCleanup.includeUploadedFiles) {
      results.push(await cleanupUploadedFiles(cutoff, protectedIds));
    } else {
      logger.force('🧹 Cleanup: uploadedfiles skipped (DB_CLEANUP_UPLOADED_FILES is off)');
    }

    // Backstop for session keys that never received a TTL: everything written
    // before expiries existed, plus test-send trails, which have no file row for
    // the sweep above to key off. Applies an expiry, deletes nothing, and the
    // sliding refresh on send keeps live campaigns safe.
    try {
      const adoption = await adoptPersistentSessionKeys(redis);
      redisAdoption = adoption;
    } catch (err) {
      logger.warn(`⚠️  Cleanup: could not adopt persistent Redis keys: ${err.message}`);
    }
  } catch (err) {
    failed = true;
    logger.error(`❌ Cleanup failed: ${err.message}`);
    logger.error(err.stack);
  } finally {
    clearInterval(renewTimer);

    const durationMs = Date.now() - startedAt;
    const totalDeleted = results.reduce((sum, r) => sum + r.deleted, 0);

    for (const result of results) {
      const extras = [];
      if (result.filesUnlinked !== undefined) extras.push(`${result.filesUnlinked} file(s) unlinked`);
      if (result.redisKeysDropped !== undefined) extras.push(`${result.redisKeysDropped} redis key(s)`);
      if (result.capped) extras.push('hit per-run cap, will resume next run');

      logger.force(
        `🧹 Cleanup: ${result.collection} — ${result.deleted} deleted ` +
        `in ${result.batches} batch(es)${extras.length ? ` (${extras.join(', ')})` : ''}`
      );
    }

    if (redisAdoption) {
      logger.force(
        `🧹 Cleanup: redis session keys — ${redisAdoption.scanned} scanned, ` +
        `${redisAdoption.adopted} given a ${redisAdoption.ttlSeconds}s expiry` +
        `${redisAdoption.capped ? ' (hit scan cap, will resume next run)' : ''}`
      );
    }

    logger.force(
      `🧹 Cleanup ${failed ? 'finished with errors' : 'finished'} — ` +
      `${totalDeleted} document(s) deleted in ${durationMs}ms`
    );

    // Recorded even on failure so a persistently failing sweep retries on the
    // normal schedule instead of on every restart.
    try {
      await redis.set(LAST_RUN_KEY, String(Date.now()));
    } catch (err) {
      logger.warn(`⚠️  Cleanup: could not record last-run timestamp: ${err.message}`);
    }

    await releaseLock(redis, token);
    running = false;
  }

  return {
    totalDeleted: results.reduce((sum, r) => sum + r.deleted, 0),
    results,
    redisAdoption,
    failed
  };
}

function scheduleNext(delayMs) {
  if (scheduleTimer) clearTimeout(scheduleTimer);

  scheduleTimer = setTimeout(async () => {
    try {
      await runCleanup('scheduled');
    } catch (err) {
      logger.error(`❌ Cleanup scheduler error: ${err.message}`);
    } finally {
      scheduleNext(env.dbCleanup.intervalMs);
    }
  }, delayMs);

  // Never hold the event loop open on cleanup's account; the HTTP server is
  // what keeps this process alive.
  if (typeof scheduleTimer.unref === 'function') scheduleTimer.unref();
}

/**
 * Decides when this process should first sweep.
 *
 * The last-run timestamp lives in Redis, which is what carries the schedule
 * across restarts and across the 4 cluster instances. A restart therefore does
 * not restart the retention clock: if the interval already elapsed while the
 * process was down, the sweep runs shortly after boot; if it did not, the next
 * run lands at the originally intended time rather than a fresh full interval
 * later. Frequent deploys can no longer starve cleanup indefinitely.
 */
async function resolveInitialDelay() {
  const redis = getSharedRedisClient();

  try {
    const raw = await redis.get(LAST_RUN_KEY);
    const lastRunAt = Number(raw);

    if (!raw || !Number.isFinite(lastRunAt) || lastRunAt <= 0) {
      return { delayMs: BOOT_GRACE_MS, reason: 'no previous run recorded' };
    }

    const elapsed = Date.now() - lastRunAt;
    const due = env.dbCleanup.intervalMs - elapsed;

    if (due <= 0) {
      return {
        delayMs: BOOT_GRACE_MS,
        reason: `overdue by ${Math.round(-due / 60000)} minute(s)`
      };
    }

    return {
      delayMs: Math.max(BOOT_GRACE_MS, due),
      reason: `next run due in ${Math.round(due / 60000)} minute(s)`
    };
  } catch (err) {
    logger.warn(`⚠️  Cleanup: could not read last-run timestamp (${err.message}); using boot delay`);
    return { delayMs: BOOT_GRACE_MS, reason: 'redis unavailable' };
  }
}

/**
 * Starts the scheduler. Safe to call once per process at boot.
 *
 * Waits for MongoDB before reconciling the TTL index, because connectMongoDB()
 * does not block and the collection command would otherwise race the handshake.
 */
function startCleanupScheduler() {
  if (!env.dbCleanup.enabled) {
    logger.force('🧹 Cleanup: disabled (DB_CLEANUP_ENABLED is off)');
    return;
  }

  const begin = async () => {
    logger.force(
      `🧹 Cleanup scheduler active — retention ${env.dbCleanup.retentionDays} day(s), ` +
      `sweeping every ${env.dbCleanup.intervalHours}h, ` +
      `batch ${env.dbCleanup.batchSize}, cap ${env.dbCleanup.maxDeletesPerRun}/collection/run`
    );

    await reconcileTtlIndex();

    const { delayMs, reason } = await resolveInitialDelay();
    logger.force(`🧹 Cleanup: first sweep in ${Math.round(delayMs / 1000)}s (${reason})`);

    scheduleNext(delayMs);
  };

  if (mongoose.connection.readyState === 1) {
    begin().catch((err) => logger.error(`❌ Cleanup: failed to start scheduler: ${err.message}`));
  } else {
    mongoose.connection.once('connected', () => {
      begin().catch((err) => logger.error(`❌ Cleanup: failed to start scheduler: ${err.message}`));
    });
  }
}

function stopCleanupScheduler() {
  if (scheduleTimer) {
    clearTimeout(scheduleTimer);
    scheduleTimer = null;
  }
}

module.exports = {
  startCleanupScheduler,
  stopCleanupScheduler,
  runCleanup,
  reconcileTtlIndex,
  cutoffDate
};
