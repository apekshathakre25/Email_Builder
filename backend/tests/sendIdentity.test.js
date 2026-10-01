/**
 * Per-send identity through the stop / restart / resend flow.
 *
 * THE PROBLEM. A recipient list is a list of sends, so bob@example.com listed three
 * times is three emails. Stopping a campaign has to put the *outstanding sends* back
 * in line, and the backlog used to record only `{ email, sourceFile }`. Keyed on the
 * address, three outstanding sends to bob collapsed into one and two were lost.
 * Removing that collapse instead exposed the opposite fault: the purge records a
 * recipient for resend *before* removing its job (deliberately — the reverse order
 * loses it if the process dies between the two), so a crash in that window leaves the
 * job alive, the worker declines it on the stop check and queues it again, and the
 * same send is recorded twice. Without an identity the two cases are
 * indistinguishable: either duplicates are dropped or races double-send.
 *
 * THE FIX. Every entry carries `sendId = "<sourceFile>#<indexInThatFile>"`, a
 * position in a file's stored recipient list. That list is written once at upload and
 * never mutated, so the position names exactly one send. The backlog collapses on
 * that id, never on the address:
 *
 *   send A#0 -> bob@example.com   ┐
 *   send A#1 -> bob@example.com   ├─ three distinct ids, all three resume
 *   send A#2 -> bob@example.com   ┘
 *   send A#1 recorded twice       -> one id, resumes once
 */

// Required first: it moves Redis onto an isolated database before
// routes/sendemails (which builds a client at require time) can be loaded.
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

const {
  queueForResend,
  takeResendQueue,
  resendQueueLength,
  resendIdentity
} = require('../utils/campaignStop');

let redis;

/** The id /send-email assigns to entry `index` of file `fileId`. */
const sendIdFor = (fileId, index) => `${fileId}#${index}`;

const tally = (values) =>
  values.reduce((acc, v) => ({ ...acc, [v]: (acc[v] || 0) + 1 }), {});

test.before(async () => {
  await startTestDb();
  redis = getSharedRedisClient();
  await clearTestRedisKeys();
});

test.after(async () => {
  await clearTestRedisKeys();
  await stopTestDb();
});

test.beforeEach(async () => {
  await clearCollections();
  await clearTestRedisKeys();
});

/* ================================================================== *
 * The identity itself.
 * ================================================================== */

test('resendIdentity keys on the sendId, so the same address yields different ids', () => {
  const a = resendIdentity('fileA#0', 'bob@example.com', 'fileA');
  const b = resendIdentity('fileA#1', 'bob@example.com', 'fileA');
  const c = resendIdentity('fileA#2', 'bob@example.com', 'fileA');

  assert.equal(new Set([a, b, c]).size, 3, 'three sends to one address are three identities');
});

test('resendIdentity is stable for the same send', () => {
  assert.equal(
    resendIdentity('fileA#1', 'bob@example.com', 'fileA'),
    resendIdentity('fileA#1', 'bob@example.com', 'fileA'),
    'the same send recorded twice must produce one identity'
  );
});

test('resendIdentity falls back to the address when no sendId exists', () => {
  // Entries queued before sendId existed keep their original collapse-by-address
  // behaviour, so a campaign mid-flight across a deploy does not change semantics.
  const one = resendIdentity('', 'bob@example.com', 'fileA');
  const two = resendIdentity(undefined, 'bob@example.com', 'fileA');

  assert.equal(one, two);
  assert.notEqual(
    one,
    resendIdentity('', 'bob@example.com', 'fileB'),
    'the fallback is still scoped per file, so two files are never confused'
  );
});

/* ================================================================== *
 * Stop -> restart with a duplicated recipient.
 * ================================================================== */

test('stop then restart: three outstanding sends to one address all resume', async () => {
  const fileId = testSessionId('stop-three');

  // A stop discarding three in-flight jobs, all to the same recipient. Each was a
  // distinct entry in the file, so each has its own id.
  await queueForResend(redis, fileId, [
    { email: 'bob@example.com', sourceFile: fileId, sendId: sendIdFor(fileId, 0) },
    { email: 'bob@example.com', sourceFile: fileId, sendId: sendIdFor(fileId, 1) },
    { email: 'bob@example.com', sourceFile: fileId, sendId: sendIdFor(fileId, 2) }
  ]);

  const resumed = await takeResendQueue(redis, fileId);

  assert.equal(resumed.length, 3, 'a campaign owing bob three emails resumes owing three');
  assert.deepEqual(resumed.map((e) => e.sendId), [
    sendIdFor(fileId, 0), sendIdFor(fileId, 1), sendIdFor(fileId, 2)
  ]);
  assert.deepEqual(tally(resumed.map((e) => e.email)), { 'bob@example.com': 3 });
});

test('stop then restart: a send recorded twice by the purge race resumes once', async () => {
  const fileId = testSessionId('stop-race');

  // The race: purgeStoppedCampaignJobs recorded send #1 and then died before
  // removing its job; the worker declined that job and recorded the same send again.
  const duplicatedRecord = {
    email: 'bob@example.com', sourceFile: fileId, sendId: sendIdFor(fileId, 1)
  };

  await queueForResend(redis, fileId, [
    { email: 'bob@example.com', sourceFile: fileId, sendId: sendIdFor(fileId, 0) },
    duplicatedRecord,
    duplicatedRecord
  ]);

  assert.equal(await resendQueueLength(redis, fileId), 3, 'all three records are stored');

  const resumed = await takeResendQueue(redis, fileId);

  assert.equal(resumed.length, 2, 'the doubly-recorded send resumes once, not twice');
  assert.deepEqual(resumed.map((e) => e.sendId), [sendIdFor(fileId, 0), sendIdFor(fileId, 1)]);
});

test('the race guard does not touch genuinely distinct sends to the same address', async () => {
  const fileId = testSessionId('stop-mixed');

  // Sends #0 and #2 are outstanding once each; send #1 got recorded twice by the race.
  await queueForResend(redis, fileId, [
    { email: 'bob@example.com', sourceFile: fileId, sendId: sendIdFor(fileId, 0) },
    { email: 'bob@example.com', sourceFile: fileId, sendId: sendIdFor(fileId, 1) },
    { email: 'bob@example.com', sourceFile: fileId, sendId: sendIdFor(fileId, 1) },
    { email: 'bob@example.com', sourceFile: fileId, sendId: sendIdFor(fileId, 2) }
  ]);

  const resumed = await takeResendQueue(redis, fileId);

  assert.equal(resumed.length, 3, 'three real sends survive; only the duplicate record goes');
  assert.deepEqual(resumed.map((e) => e.sendId), [
    sendIdFor(fileId, 0), sendIdFor(fileId, 1), sendIdFor(fileId, 2)
  ]);
});

test('stop then restart across two files: a shared address keeps both sends', async () => {
  const campaign = testSessionId('stop-two-files');
  const fileA = testSessionId('stop-file-A');
  const fileB = testSessionId('stop-file-B');

  await queueForResend(redis, campaign, [
    { email: 'bob@example.com', sourceFile: fileA, sendId: sendIdFor(fileA, 0) },
    { email: 'bob@example.com', sourceFile: fileB, sendId: sendIdFor(fileB, 0) }
  ]);

  const resumed = await takeResendQueue(redis, campaign);

  assert.equal(resumed.length, 2, 'one send per file, not merged');
  assert.deepEqual(resumed.map((e) => e.sourceFile), [fileA, fileB],
    'and each keeps the file it came from, so per-file counters stay correct');
});

test('the resumed entries carry the source file and id needed to re-enqueue them', async () => {
  const fileId = testSessionId('stop-shape');

  await queueForResend(redis, fileId, [
    { email: 'bob@example.com', sourceFile: fileId, sendId: sendIdFor(fileId, 7) }
  ]);

  const [entry] = await takeResendQueue(redis, fileId);

  assert.deepEqual(entry, {
    email: 'bob@example.com',
    sourceFile: fileId,
    sendId: sendIdFor(fileId, 7)
  });
});

/* ================================================================== *
 * Backward compatibility with backlog entries that predate sendId.
 * ================================================================== */

test('entries without a sendId still collapse by address, as they did before', async () => {
  const fileId = testSessionId('legacy-entries');

  // Written by the previous build: no id at all.
  await queueForResend(redis, fileId, [
    { email: 'bob@example.com', sourceFile: fileId },
    { email: 'bob@example.com', sourceFile: fileId },
    { email: 'alice@example.com', sourceFile: fileId }
  ]);

  const resumed = await takeResendQueue(redis, fileId);

  assert.equal(resumed.length, 2, 'old entries keep the semantics they were queued under');
  assert.deepEqual(resumed.map((e) => e.email).sort(),
    ['alice@example.com', 'bob@example.com']);
});

test('a bare string in the backlog is still tolerated rather than dropped', async () => {
  const fileId = testSessionId('legacy-string');

  await redis.rpush(`resend:${fileId}`, 'plain@example.com');

  const resumed = await takeResendQueue(redis, fileId);

  assert.equal(resumed.length, 1);
  assert.equal(resumed[0].email, 'plain@example.com');
  assert.equal(resumed[0].sourceFile, fileId, 'falls back to the campaign as the source');
});

test('new and legacy entries coexist without interfering', async () => {
  const fileId = testSessionId('legacy-mixed');

  await queueForResend(redis, fileId, [
    { email: 'bob@example.com', sourceFile: fileId },                                  // legacy
    { email: 'bob@example.com', sourceFile: fileId, sendId: sendIdFor(fileId, 0) },    // new
    { email: 'bob@example.com', sourceFile: fileId, sendId: sendIdFor(fileId, 1) }     // new
  ]);

  const resumed = await takeResendQueue(redis, fileId);

  // The legacy entry collapses among itself; the two identified sends are distinct.
  assert.equal(resumed.length, 3);
  assert.deepEqual(resumed.map((e) => e.sendId), ['', sendIdFor(fileId, 0), sendIdFor(fileId, 1)]);
});

/* ================================================================== *
 * Normal sending is unchanged.
 * ================================================================== */

test('a campaign with no duplicates behaves exactly as before', async () => {
  const fileId = testSessionId('no-dupes-resend');

  await queueForResend(redis, fileId, [
    { email: 'a@example.com', sourceFile: fileId, sendId: sendIdFor(fileId, 0) },
    { email: 'b@example.com', sourceFile: fileId, sendId: sendIdFor(fileId, 1) },
    { email: 'c@example.com', sourceFile: fileId, sendId: sendIdFor(fileId, 2) }
  ]);

  const resumed = await takeResendQueue(redis, fileId);

  assert.deepEqual(resumed.map((e) => e.email), ['a@example.com', 'b@example.com', 'c@example.com']);
});

test('the backlog is emptied by the drain, so a restart cannot replay it', async () => {
  const fileId = testSessionId('drain-empties');

  await queueForResend(redis, fileId, [
    { email: 'bob@example.com', sourceFile: fileId, sendId: sendIdFor(fileId, 0) },
    { email: 'bob@example.com', sourceFile: fileId, sendId: sendIdFor(fileId, 1) }
  ]);

  assert.equal((await takeResendQueue(redis, fileId)).length, 2);
  assert.equal(await resendQueueLength(redis, fileId), 0, 'drained atomically');
  assert.deepEqual(await takeResendQueue(redis, fileId), [], 'a second restart resends nothing');
});

test('an entry with no email is still rejected at the queueing step', async () => {
  const fileId = testSessionId('reject-empty');

  const queued = await queueForResend(redis, fileId, [
    { email: '', sourceFile: fileId, sendId: sendIdFor(fileId, 0) },
    { sourceFile: fileId, sendId: sendIdFor(fileId, 1) },
    { email: 'ok@example.com', sourceFile: fileId, sendId: sendIdFor(fileId, 2) }
  ]);

  assert.equal(queued, 1, 'only the entry with a real address is stored');
  assert.deepEqual((await takeResendQueue(redis, fileId)).map((e) => e.email), ['ok@example.com']);
});
