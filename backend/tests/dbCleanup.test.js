/**
 * Retention sweep behaviour.
 *
 * The point of these tests is the negative cases. Deleting old rows is easy; the
 * risk in this feature is deleting something that is still needed. Each "must
 * survive" assertion corresponds to a real code path that would break:
 *
 *   operator config      -> resolveSmtpPass() at send time, /interface page load
 *   in_progress campaign -> the worker's BatchLogger is still $inc-ing counters
 *   uploaded / processing files -> a staged list is pending work, not garbage
 *   recent data          -> inside the retention window by definition
 */

// Required first: it moves Redis onto an isolated database before any module can
// open a connection.
const {
  startTestDb,
  stopTestDb,
  clearCollections,
  clearTestRedisKeys,
  testSessionId,
  getSharedRedisClient
} = require('./helpers/testDb');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const env = require('../config/env');

const { runCleanup, reconcileTtlIndex, cutoffDate } = require('../utils/dbCleanup');
const { recipientsKey, sentIndexKey, emailLogKey } = require('../utils/sessionKeys');

const EmailLog = require('../models/EmailLog');
const EmailLogEntry = require('../models/EmailLogEntry');
const ImapTestResult = require('../models/ImapTestResult');
const UploadedFile = require('../models/UploadedFile');
const EmailConfig = require('../models/EmailConfig');
const { TestEmailAccount, ImapCredentials } = require('../models/TestEmailAccount');

const DAY = 86400000;
const ago = (days) => new Date(Date.now() - days * DAY);

const DONE = testSessionId('sweep-done');
const LIVE = testSessionId('sweep-live');
const ABANDONED = testSessionId('sweep-abandoned');
const FRESH = testSessionId('sweep-fresh');
const STAGED = testSessionId('sweep-staged');
const BUSY = testSessionId('sweep-busy');

let redis;
let tmpFile;

async function seed() {
  await EmailLog.insertMany([
    { sessionId: DONE, fromEmail: 'a@x.com', subject: 's', totalRecipients: 250, status: 'completed', createdAt: ago(10) },
    { sessionId: LIVE, fromEmail: 'a@x.com', subject: 's', totalRecipients: 5, status: 'in_progress', createdAt: ago(10) },
    { sessionId: ABANDONED, fromEmail: 'a@x.com', subject: 's', totalRecipients: 5, status: 'in_progress', createdAt: ago(40) },
    { sessionId: FRESH, fromEmail: 'a@x.com', subject: 's', totalRecipients: 5, status: 'completed', createdAt: ago(1) }
  ]);

  const entries = [];
  // 250 old entries against a batch size of 100 forces multiple batches.
  for (let i = 0; i < 250; i++) {
    entries.push({ sessionId: DONE, campaignId: DONE, email: `old${i}@x.com`, status: 'sent', time: ago(10) });
  }
  for (let i = 0; i < 5; i++) {
    entries.push({ sessionId: LIVE, campaignId: LIVE, email: `live${i}@x.com`, status: 'sent', time: ago(10) });
    entries.push({ sessionId: FRESH, campaignId: FRESH, email: `fresh${i}@x.com`, status: 'sent', time: ago(1) });
    entries.push({ sessionId: ABANDONED, campaignId: ABANDONED, email: `ab${i}@x.com`, status: 'sent', time: ago(40) });
  }
  await EmailLogEntry.insertMany(entries);

  await ImapTestResult.insertMany([
    { testId: 'sweep-t-old-1', testType: 'auto', testEmail: 'a@x.com', ipAddress: '1.1.1.1', userId: 'u@x.com', createdAt: ago(10) },
    { testId: 'sweep-t-old-2', testType: 'manual', testEmail: 'a@x.com', ipAddress: '1.1.1.1', userId: 'u@x.com', createdAt: ago(4) },
    { testId: 'sweep-t-new-1', testType: 'auto', testEmail: 'a@x.com', ipAddress: '1.1.1.1', userId: 'u@x.com', createdAt: ago(1) }
  ]);

  tmpFile = path.join(os.tmpdir(), `testsuite-recipients-${Date.now()}.csv`);
  fs.writeFileSync(tmpFile, 'a@x.com\n', 'utf8');

  await UploadedFile.insertMany([
    { originalName: 'done.csv', storedPath: tmpFile, fileSize: 10, fileType: '.csv', sessionId: DONE, status: 'completed', uploadDate: ago(10) },
    { originalName: 'staged.csv', storedPath: '/nonexistent/staged.csv', fileSize: 10, fileType: '.csv', sessionId: STAGED, status: 'uploaded', uploadDate: ago(10) },
    { originalName: 'busy.csv', storedPath: '/nonexistent/busy.csv', fileSize: 10, fileType: '.csv', sessionId: BUSY, status: 'processing', uploadDate: ago(10) },
    { originalName: 'recent.csv', storedPath: '/nonexistent/recent.csv', fileSize: 10, fileType: '.csv', sessionId: FRESH, status: 'completed', uploadDate: ago(1) }
  ]);

  await EmailConfig.create({ userId: 'op@x.com', smtpHost: 'smtp.x.com', updatedAt: ago(400) });
  await TestEmailAccount.create({ email: 'seed@x.com', password: 'ciphertext', addedAt: ago(400) });
  await ImapCredentials.create({ userId: 'op@x.com', host: 'imap.x.com', updatedAt: ago(400) });

  await redis.rpush(recipientsKey(DONE), 'a@x.com');
  await redis.set(sentIndexKey(DONE), '1');
  await redis.rpush(emailLogKey(DONE), '{}');
  await redis.rpush(recipientsKey(FRESH), 'b@x.com');
}

let summary;

test.before(async () => {
  await startTestDb();
  redis = getSharedRedisClient();
  await clearCollections();
  await clearTestRedisKeys();
  await seed();

  // Batch size is read from env at call time; shrink it so batching is exercised.
  env.dbCleanup.batchSize = 100;

  summary = await runCleanup('test-suite', { force: true });
  assert.ok(summary, 'runCleanup returned null; lock or connection problem');
});

test.after(async () => {
  if (tmpFile && fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  await clearTestRedisKeys();
  await stopTestDb();
});

test('cutoff is derived from DB_CLEANUP_DAYS', () => {
  const ageDays = (Date.now() - cutoffDate().getTime()) / DAY;
  assert.ok(
    Math.abs(ageDays - env.dbCleanup.retentionDays) < 0.001,
    `cutoff was ${ageDays} days old, expected ${env.dbCleanup.retentionDays}`
  );
});

test('deletes run in batches rather than one unbounded deleteMany', () => {
  const entries = summary.results.find((r) => r.collection === 'emaillogentries');
  assert.ok(entries.batches >= 3, `expected 3+ batches at batchSize=100, got ${entries.batches}`);
});

test('old per-recipient entries are deleted', async () => {
  assert.equal(await EmailLogEntry.countDocuments({ campaignId: DONE }), 0);
});

test('entries of an in-progress campaign survive regardless of age', async () => {
  assert.equal(await EmailLogEntry.countDocuments({ campaignId: LIVE }), 5);
});

test('recent entries survive', async () => {
  assert.equal(await EmailLogEntry.countDocuments({ campaignId: FRESH }), 5);
});

test('entries of a long-abandoned in-progress campaign are released', async () => {
  assert.equal(await EmailLogEntry.countDocuments({ campaignId: ABANDONED }), 0);
});

test('old settled campaign log is deleted, live one is kept', async () => {
  assert.equal(await EmailLog.countDocuments({ sessionId: DONE }), 0);
  assert.equal(await EmailLog.countDocuments({ sessionId: LIVE }), 1);
  assert.equal(await EmailLog.countDocuments({ sessionId: FRESH }), 1);
});

test('abandoned in-progress log is deleted, not left as a zombie row', async () => {
  assert.equal(
    await EmailLog.countDocuments({ sessionId: ABANDONED }),
    0,
    'its entries were cleaned, so the summary must go too'
  );
});

test('old inbox tests are deleted and recent ones kept', async () => {
  assert.equal(await ImapTestResult.countDocuments({ testId: { $in: ['sweep-t-old-1', 'sweep-t-old-2'] } }), 0);
  assert.equal(await ImapTestResult.countDocuments({ testId: 'sweep-t-new-1' }), 1);
});

test('spent recipient file is removed from the database and from disk', async () => {
  assert.equal(await UploadedFile.countDocuments({ sessionId: DONE }), 0);
  assert.equal(fs.existsSync(tmpFile), false, 'the file on disk must go with the row');
});

test('staged and processing files survive: they are pending work, not garbage', async () => {
  assert.equal(await UploadedFile.countDocuments({ sessionId: STAGED }), 1);
  assert.equal(await UploadedFile.countDocuments({ sessionId: BUSY }), 1);
  assert.equal(await UploadedFile.countDocuments({ sessionId: FRESH }), 1);
});

test('Redis keys of a swept file are removed explicitly, not left to the TTL', async () => {
  assert.equal(await redis.exists(recipientsKey(DONE)), 0);
  assert.equal(await redis.exists(sentIndexKey(DONE)), 0);
  assert.equal(await redis.exists(emailLogKey(DONE)), 0);
});

test('Redis keys of a live session are untouched', async () => {
  assert.equal(await redis.exists(recipientsKey(FRESH)), 1);
});

test('the sweep reports Redis key adoption', () => {
  assert.ok(summary.redisAdoption, 'expected an adoption summary');
  assert.equal(summary.redisAdoption.ttlSeconds, env.dbCleanup.retentionSeconds * 4);
});

test('operator configuration is never age-deleted', async () => {
  assert.equal(await EmailConfig.countDocuments({}), 1, 'saved SMTP draft must survive');
  assert.equal(await TestEmailAccount.countDocuments({}), 1, 'IMAP seed account must survive');
  assert.equal(await ImapCredentials.countDocuments({}), 1, 'IMAP settings must survive');
});

test('the distributed lock is released and the run is recorded', async () => {
  assert.equal(await redis.exists('dbcleanup:lock'), 0);
  assert.equal(await redis.exists('dbcleanup:lastRunAt'), 1);
});

test('a second scheduled run inside the interval is skipped', async () => {
  const second = await runCleanup('test-suite-again');
  assert.equal(second, null, 'the shared due-check should suppress a repeat sweep');
});

test('TTL index on imaptestresults matches the configured retention', async () => {
  await reconcileTtlIndex();
  const indexes = await ImapTestResult.collection.indexes();
  const ttl = indexes.find((i) => i.name === 'createdAt_ttl');

  assert.ok(ttl, 'TTL index should exist');
  assert.equal(ttl.expireAfterSeconds, env.dbCleanup.retentionSeconds);
});
