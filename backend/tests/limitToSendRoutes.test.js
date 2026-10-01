/**
 * "Limit to Send" through POST /send-email, with a real Bull queue.
 *
 * Asserts on the jobs actually enqueued, because that is what the workers will send.
 * Counting an internal variable would not prove a recipient was released exactly once.
 *
 * Workers are not running, so jobs accumulate and can be inspected. Each test uses its
 * own file ids and filters the queue by them, because flushing Redis underneath a live
 * Bull queue leaves the client unable to read back what it just wrote.
 */

// Required first: it moves Redis onto an isolated database before routes/sendemails
// (which builds a client at require time) can be loaded.
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
const express = require('express');
const fs = require('node:fs');

const UploadedFile = require('../models/UploadedFile');
const EmailLog = require('../models/EmailLog');
const emailQueue = require('../workprocess/queue');
const { stopCampaign, queueForResend } = require('../utils/campaignStop');
const { seedEmailStats } = require('../utils/sessionKeys');

const USER = 'operator@example.com';

let server;
let baseUrl;
let redis;

function buildTestApp() {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = { email: USER, name: 'Operator' };
    next();
  });
  app.use('/', require('../routes/sendemails'));
  return app;
}

/** Uploads `rows` as a CSV under a caller-chosen file id. */
async function uploadFile(rows, fileId) {
  const form = new FormData();
  form.append('file', new Blob([rows.join('\n')], { type: 'text/csv' }), `${fileId}.csv`);

  const res = await fetch(`${baseUrl}/recipients`, {
    method: 'POST',
    body: form,
    headers: { 'x-session-id': fileId }
  });
  return res.json();
}

/** One Send Email action. `limitToSend`/`interval` are omitted when null. */
async function sendEmail(fileIds, { limit = 500, limitToSend = null, interval = null } = {}) {
  const body = new URLSearchParams({
    'smtp-host': '127.0.0.1', 'smtp-port': '2525',
    'smtp-user': 'u@example.com', 'smtp-pass': 'p',
    'smtp-from-email': 'u@example.com', 'smtp-from-name': 'Sender',
    subject: 'Limit to Send', 'test-bulk': 'Bulk',
    'message-type': 'Plain', message: 'body',
    'file-ids': fileIds.join(','),
    limit: String(limit)
  });
  if (limitToSend !== null) body.set('limit-to-send', String(limitToSend));
  if (interval !== null) body.set('interval-seconds', String(interval));

  const res = await fetch(`${baseUrl}/send-email`, { method: 'POST', body });
  return { status: res.status, body: await res.json() };
}

/**
 * Every queued job belonging to `ownerIds`, in enqueue order, deduped on the Bull job id
 * because getJobs() concatenates one lookup per state and a job can appear in several.
 */
async function queuedSends(ownerIds) {
  const owners = new Set(ownerIds);
  const jobs = await emailQueue.getJobs(['waiting', 'delayed', 'active'], 0, 5000);

  const byId = new Map();
  for (const job of jobs) {
    if (!job || !job.data) continue;
    if (!owners.has(job.data.originalSessionId)) continue;
    byId.set(String(job.id), job);
  }

  return [...byId.values()]
    .sort((a, b) => Number(a.id) - Number(b.id))
    .map((j) => ({ email: j.data.email, sendId: j.data.sendId }));
}

/** Waits for the enqueue, which /send-email performs in a setImmediate after responding. */
async function waitForSends(ownerIds, expected, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let sends = [];
  while (Date.now() < deadline) {
    sends = await queuedSends(ownerIds);
    if (sends.length >= expected) return sends;
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  return sends;
}

/** Marks `count` of a campaign's released entries as settled, the way the worker does. */
async function settle(campaignId, count) {
  await seedEmailStats(redis, campaignId, { sent: 0, failed: 0 });
  await redis.hincrby(`emailstats:${campaignId}`, 'sent', count);
  await EmailLog.updateOne({ sessionId: campaignId }, { $inc: { sentCount: count } });
}

const watermark = async (id) => Number(await redis.get(`sentIndex:${id}`)) || 0;

test.before(async () => {
  await startTestDb();
  redis = getSharedRedisClient();
  await clearTestRedisKeys();

  const app = buildTestApp();
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await emailQueue.close();
  await clearTestRedisKeys();
  await stopTestDb();
});

test.afterEach(async () => {
  const files = await UploadedFile.find({}, 'storedPath').lean();
  for (const { storedPath } of files) {
    if (storedPath && fs.existsSync(storedPath)) fs.unlinkSync(storedPath);
  }
  await clearCollections();
  // Redis and the queue are left intact; tests filter by their own file ids.
});

/* ================================================================== *
 * 1-3. 70 -> 30 -> 30 -> 10, scaled down but the same arithmetic.
 * ================================================================== */

test('three clicks release 30/30/10 of a 70-entry campaign', async () => {
  const fileId = testSessionId('walk');
  await uploadFile(Array.from({ length: 70 }, (_, i) => `r${i}@example.com`), fileId);

  // Click 1
  const first = await sendEmail([fileId], { limitToSend: 30 });
  assert.equal(first.body.batchCount, 30, 'only 30 released, not all 70');
  let sends = await waitForSends([fileId], 30);
  assert.equal(sends.length, 30);
  assert.deepEqual(sends.map((s) => s.sendId), Array.from({ length: 30 }, (_, i) => `${fileId}#${i}`),
    'entries 0..29');
  assert.equal(await watermark(fileId), 30, 'the server records what it released');
  await settle(fileId, 30);

  // Click 2 — continues, does not restart
  const second = await sendEmail([fileId], { limitToSend: 30 });
  assert.equal(second.body.batchCount, 30);
  sends = await waitForSends([fileId], 60);
  assert.deepEqual(sends.slice(30).map((s) => s.sendId),
    Array.from({ length: 30 }, (_, i) => `${fileId}#${30 + i}`), 'entries 30..59');
  assert.equal(await watermark(fileId), 60);
  await settle(fileId, 30);

  // Click 3 — only the remaining 10, not another 30
  const third = await sendEmail([fileId], { limitToSend: 30 });
  assert.equal(third.body.batchCount, 10, 'the cap does not invent recipients');
  sends = await waitForSends([fileId], 70);
  assert.deepEqual(sends.slice(60).map((s) => s.sendId),
    Array.from({ length: 10 }, (_, i) => `${fileId}#${60 + i}`), 'entries 60..69');
  assert.equal(await watermark(fileId), 70);

  /* 4 and 5: every entry exactly once, none skipped. */
  const allSendIds = sends.map((s) => s.sendId);
  assert.equal(allSendIds.length, 70);
  assert.equal(new Set(allSendIds).size, 70, 'no entry queued twice');
  assert.deepEqual(allSendIds, Array.from({ length: 70 }, (_, i) => `${fileId}#${i}`),
    'and none skipped, in order');
});

test('a fourth click has nothing left and is refused', async () => {
  const fileId = testSessionId('exhaust');
  await uploadFile(Array.from({ length: 10 }, (_, i) => `r${i}@example.com`), fileId);

  await sendEmail([fileId], { limitToSend: 10 });
  await waitForSends([fileId], 10);

  const again = await sendEmail([fileId], { limitToSend: 10 });
  assert.equal(again.status, 400, 'nothing to send');
  assert.match(again.body.error, /No more recipients/);
  assert.equal((await queuedSends([fileId])).length, 10, 'and nothing extra was queued');
});

/* ================================================================== *
 * 8. A cap above the remainder sends only the remainder.
 * ================================================================== */

test('a cap larger than the campaign releases only what exists', async () => {
  const fileId = testSessionId('cap-big');
  await uploadFile(Array.from({ length: 12 }, (_, i) => `r${i}@example.com`), fileId);

  const sent = await sendEmail([fileId], { limitToSend: 30000 });

  assert.equal(sent.body.batchCount, 12, 'only the 12 that exist');
  assert.equal((await waitForSends([fileId], 12)).length, 12);
  assert.equal(await watermark(fileId), 12, 'and the watermark does not run past the total');
});

/* ================================================================== *
 * 6-7. The rate is untouched, and unaffected by the cap.
 * ================================================================== */

test('Limit and Interval still reach the jobs as the rate, unchanged', async () => {
  const fileId = testSessionId('rate');
  await uploadFile(Array.from({ length: 20 }, (_, i) => `r${i}@example.com`), fileId);

  await sendEmail([fileId], { limit: 5, interval: 2, limitToSend: 8 });
  await waitForSends([fileId], 8);

  const jobs = await emailQueue.getJobs(['waiting', 'delayed', 'active'], 0, 5000);
  const mine = jobs.filter((j) => j && j.data && j.data.originalSessionId === fileId);

  assert.equal(mine.length, 8, 'the cap decided how many');
  for (const job of mine) {
    assert.deepEqual(
      { limit: job.data.rateLimit.limit, intervalMs: job.data.rateLimit.intervalMs },
      { limit: 5, intervalMs: 2000 },
      'and the rate on every job is exactly what was configured'
    );
  }

  const log = await EmailLog.findOne({ sessionId: fileId }).lean();
  assert.deepEqual(
    { limit: log.rateLimit.limit, intervalSeconds: log.rateLimit.intervalSeconds },
    { limit: 5, intervalSeconds: 2 },
    'the campaign records the rate it is running at, not the cap'
  );
});

test('the cap works in paced mode, where Limit alone never bounded the submission', async () => {
  // This is the case the feature exists for. With an interval set, `limit` is a rate and
  // every remaining recipient used to be enqueued at once.
  const fileId = testSessionId('paced');
  await uploadFile(Array.from({ length: 50 }, (_, i) => `r${i}@example.com`), fileId);

  const capped = await sendEmail([fileId], { limit: 10, interval: 2, limitToSend: 20 });
  assert.equal(capped.body.batchCount, 20, 'capped despite pacing');
  assert.equal((await waitForSends([fileId], 20)).length, 20);
  assert.equal(await watermark(fileId), 20, '30 still pending');
});

test('without a cap, paced mode still releases everything remaining', async () => {
  const fileId = testSessionId('paced-nocap');
  await uploadFile(Array.from({ length: 50 }, (_, i) => `r${i}@example.com`), fileId);

  const all = await sendEmail([fileId], { limit: 10, interval: 2 });
  assert.equal(all.body.batchCount, 50, 'unchanged from before this feature');
  assert.equal(await watermark(fileId), 50);
});

/* ================================================================== *
 * 16. No cap = previous behaviour.
 * ================================================================== */

test('without a cap, unpaced mode still uses Limit as the batch size', async () => {
  const fileId = testSessionId('unpaced-nocap');
  await uploadFile(Array.from({ length: 50 }, (_, i) => `r${i}@example.com`), fileId);

  const batched = await sendEmail([fileId], { limit: 20 });
  assert.equal(batched.body.batchCount, 20, 'Limit as a batch size, exactly as before');
  assert.equal(await watermark(fileId), 20);
});

test('an empty Limit to Send is treated as absent', async () => {
  const fileId = testSessionId('empty-cap');
  await uploadFile(Array.from({ length: 30 }, (_, i) => `r${i}@example.com`), fileId);

  const body = new URLSearchParams({
    'smtp-host': '127.0.0.1', 'smtp-port': '2525',
    'smtp-user': 'u@example.com', 'smtp-pass': 'p',
    'smtp-from-email': 'u@example.com', 'smtp-from-name': 'Sender',
    subject: 'S', 'test-bulk': 'Bulk', 'message-type': 'Plain', message: 'body',
    'file-ids': fileId, limit: '500', 'limit-to-send': ''
  });

  const res = await fetch(`${baseUrl}/send-email`, { method: 'POST', body });
  const json = await res.json();

  assert.equal(res.status, 200);
  assert.equal(json.batchCount, 30, 'no cap applied');
});

test('an invalid cap is rejected before anything is queued', async () => {
  const fileId = testSessionId('bad-cap');
  await uploadFile(Array.from({ length: 10 }, (_, i) => `r${i}@example.com`), fileId);

  for (const bad of ['0', '-5', 'abc', '3.5']) {
    const res = await sendEmail([fileId], { limitToSend: bad });
    assert.equal(res.status, 400, `"${bad}" must be refused`);
    assert.match(res.body.error, /Limit to Send/);
  }

  assert.equal(await watermark(fileId), 0, 'nothing was reserved');
  assert.equal((await queuedSends([fileId])).length, 0, 'and nothing queued');
});

/* ================================================================== *
 * 9-11. Duplicates and multiple files.
 * ================================================================== */

test('duplicate addresses are separate entries and the cap counts entries', async () => {
  const fileId = testSessionId('dupes');
  // bob, bob, alice, bob — four sends, not three recipients.
  await uploadFile(
    ['bob@example.com', 'bob@example.com', 'alice@example.com', 'bob@example.com'],
    fileId
  );

  const first = await sendEmail([fileId], { limitToSend: 2 });
  assert.equal(first.body.batchCount, 2);
  let sends = await waitForSends([fileId], 2);
  assert.deepEqual(sends.map((s) => s.email), ['bob@example.com', 'bob@example.com'],
    'the first two ENTRIES, both bob');
  assert.deepEqual(sends.map((s) => s.sendId), [`${fileId}#0`, `${fileId}#1`]);
  await settle(fileId, 2);

  const second = await sendEmail([fileId], { limitToSend: 2 });
  assert.equal(second.body.batchCount, 2);
  sends = await waitForSends([fileId], 4);
  assert.deepEqual(sends.slice(2).map((s) => s.email), ['alice@example.com', 'bob@example.com'],
    'continues from the next entry');
  assert.deepEqual(sends.slice(2).map((s) => s.sendId), [`${fileId}#2`, `${fileId}#3`]);

  // Three sends to bob, tracked by identity rather than address.
  assert.equal(sends.filter((s) => s.email === 'bob@example.com').length, 3);
  assert.equal(new Set(sends.map((s) => s.sendId)).size, 4, 'four distinct identities');
});

test('multiple files are one ordered list and the cap spans the boundary', async () => {
  const fileA = testSessionId('multi-A');
  const fileB = testSessionId('multi-B');

  await uploadFile(Array.from({ length: 40 }, (_, i) => `a${i}@example.com`), fileA);
  await uploadFile(Array.from({ length: 30 }, (_, i) => `b${i}@example.com`), fileB);

  // Click 1: the first 30 of file A.
  await sendEmail([fileA, fileB], { limitToSend: 30 });
  let sends = await waitForSends([fileA, fileB], 30);
  assert.deepEqual(sends.map((s) => s.sendId), Array.from({ length: 30 }, (_, i) => `${fileA}#${i}`));
  await settle(fileA, 30);

  // Click 2: A's remaining 10, then B's first 20 — across the file boundary.
  await sendEmail([fileA, fileB], { limitToSend: 30 });
  sends = await waitForSends([fileA, fileB], 60);
  const secondBatch = sends.slice(30).map((s) => s.sendId);
  assert.deepEqual(secondBatch.slice(0, 10), Array.from({ length: 10 }, (_, i) => `${fileA}#${30 + i}`),
    'file A finishes first');
  assert.deepEqual(secondBatch.slice(10), Array.from({ length: 20 }, (_, i) => `${fileB}#${i}`),
    'then file B begins');
  await settle(fileA, 30);

  // Click 3: B's remaining 10.
  await sendEmail([fileA, fileB], { limitToSend: 30 });
  sends = await waitForSends([fileA, fileB], 70);
  assert.deepEqual(sends.slice(60).map((s) => s.sendId),
    Array.from({ length: 10 }, (_, i) => `${fileB}#${20 + i}`));

  assert.equal(new Set(sends.map((s) => s.sendId)).size, 70, 'every entry exactly once');
});

test('an address shared by two files stays two entries under a cap', async () => {
  const fileA = testSessionId('shared-A');
  const fileB = testSessionId('shared-B');

  await uploadFile(['shared@example.com', 'a@example.com'], fileA);
  await uploadFile(['shared@example.com', 'b@example.com'], fileB);

  await sendEmail([fileA, fileB], { limitToSend: 4 });
  const sends = await waitForSends([fileA, fileB], 4);

  assert.equal(sends.filter((s) => s.email === 'shared@example.com').length, 2,
    'once per file, not merged');
  assert.deepEqual(sends.map((s) => s.sendId),
    [`${fileA}#0`, `${fileA}#1`, `${fileB}#0`, `${fileB}#1`]);
});

/* ================================================================== *
 * 12-13. Stop, and resume without duplication.
 * ================================================================== */

test('a manual stop before the cap preserves the remaining entries', async () => {
  const fileId = testSessionId('stop-mid');
  await uploadFile(Array.from({ length: 50 }, (_, i) => `r${i}@example.com`), fileId);

  await sendEmail([fileId], { limitToSend: 20 });
  await waitForSends([fileId], 20);
  await settle(fileId, 5);

  await stopCampaign(redis, fileId, { stoppedBy: USER, reason: 'operator clicked Stop' });

  const log = await EmailLog.findOne({ sessionId: fileId }).lean();
  assert.notEqual(log.status, 'completed', 'a stop is not a completion');

  // The 30 never released are still pending, and the watermark has not moved past 20.
  assert.equal(await watermark(fileId), 20);
});

test('stop then resume does not resend entries, and the backlog counts against the cap', async () => {
  const fileId = testSessionId('stop-resume');
  await uploadFile(Array.from({ length: 40 }, (_, i) => `r${i}@example.com`), fileId);

  await sendEmail([fileId], { limitToSend: 10 });
  await waitForSends([fileId], 10);

  // A stop discards two released-but-unsent entries, recorded by identity.
  await stopCampaign(redis, fileId, { stoppedBy: USER });
  await queueForResend(redis, fileId, [
    { email: 'r8@example.com', sourceFile: fileId, sendId: `${fileId}#8` },
    { email: 'r9@example.com', sourceFile: fileId, sendId: `${fileId}#9` }
  ]);
  await settle(fileId, 8);

  // Resume with a cap of 10: the 2 recovered entries plus 8 new ones.
  const resumed = await sendEmail([fileId], { limitToSend: 10 });
  assert.equal(resumed.body.batchCount, 10, 'the backlog counts against the cap');
  assert.equal(await watermark(fileId), 18, 'only 8 NEW entries advanced the watermark');

  const sends = await waitForSends([fileId], 20);
  const resumedIds = sends.slice(10).map((s) => s.sendId);

  assert.deepEqual(resumedIds.slice(0, 2), [`${fileId}#8`, `${fileId}#9`],
    'the recovered entries lead');
  assert.deepEqual(resumedIds.slice(2), Array.from({ length: 8 }, (_, i) => `${fileId}#${10 + i}`),
    'then the campaign continues from where it stopped');
});

/* ================================================================== *
 * 14-15. Repeated and concurrent clicks.
 * ================================================================== */

test('repeated clicks never re-queue an entry already released', async () => {
  const fileId = testSessionId('repeat');
  await uploadFile(Array.from({ length: 30 }, (_, i) => `r${i}@example.com`), fileId);

  for (let i = 0; i < 3; i++) {
    await sendEmail([fileId], { limitToSend: 10 });
    await waitForSends([fileId], (i + 1) * 10);
    await settle(fileId, 10);
  }

  const sends = await queuedSends([fileId]);
  assert.equal(sends.length, 30);
  assert.equal(new Set(sends.map((s) => s.sendId)).size, 30, 'each entry queued exactly once');
});

test('two simultaneous clicks cannot queue the same send identity twice', async () => {
  const fileId = testSessionId('concurrent');
  await uploadFile(Array.from({ length: 60 }, (_, i) => `r${i}@example.com`), fileId);

  // The double click. Before the reservation was made atomic, both requests read the same
  // watermark, sliced the same entries and enqueued them: every recipient twice.
  const [a, b] = await Promise.all([
    sendEmail([fileId], { limitToSend: 30 }),
    sendEmail([fileId], { limitToSend: 30 })
  ]);

  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(a.body.batchCount + b.body.batchCount, 60, 'together they release 60, not 120');

  const sends = await waitForSends([fileId], 60);
  const ids = sends.map((s) => s.sendId);

  assert.equal(ids.length, 60);
  assert.equal(new Set(ids).size, 60, 'no send identity queued twice');
  assert.deepEqual([...ids].sort(), Array.from({ length: 60 }, (_, i) => `${fileId}#${i}`).sort(),
    'and none skipped');
  assert.equal(await watermark(fileId), 60);
});

/* ================================================================== *
 * 17. Completion only when everything has settled.
 * ================================================================== */

test('reaching the cap does not complete the campaign', async () => {
  const fileId = testSessionId('not-complete');
  await uploadFile(Array.from({ length: 70 }, (_, i) => `r${i}@example.com`), fileId);

  await sendEmail([fileId], { limitToSend: 30 });
  await waitForSends([fileId], 30);
  await settle(fileId, 30);

  const progress = await require('../routes/sendemails').readCampaignProgress(fileId);

  assert.equal(progress.settled, 30);
  assert.equal(progress.total, 70);
  assert.equal(progress.finished, false, '30 of 70 is not finished');
  assert.equal(progress.pending, 40, 'and 40 are still pending');
  assert.equal(progress.sentIndex, 30, 'the watermark shows what was released');

  const log = await EmailLog.findOne({ sessionId: fileId }).lean();
  assert.equal(log.status, 'in_progress', 'the campaign stays resumable');
});

test('completion is reached only once every entry has settled', async () => {
  const fileId = testSessionId('complete-at-end');
  await uploadFile(Array.from({ length: 20 }, (_, i) => `r${i}@example.com`), fileId);

  await sendEmail([fileId], { limitToSend: 10 });
  await settle(fileId, 10);
  assert.equal((await require('../routes/sendemails').readCampaignProgress(fileId)).finished, false);

  await sendEmail([fileId], { limitToSend: 10 });
  await settle(fileId, 10);

  const progress = await require('../routes/sendemails').readCampaignProgress(fileId);
  assert.equal(progress.finished, true, 'now every entry has settled');
  assert.equal(progress.settled, 20);
});
