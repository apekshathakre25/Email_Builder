/**
 * The per-send identity reaching the places that need it.
 *
 * tests/sendIdentity.test.js covers the identity rule in isolation. This covers the
 * wiring: that /send-email assigns a sendId to every entry and puts it on the job, so
 * the worker has something to queue for resend when a stop discards it, and that the
 * pending export reconciles per send rather than per address.
 *
 * Asserted against the real routes and a real queue. Workers are not running, so jobs
 * are enqueued and inspected rather than delivered.
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
const express = require('express');
const fs = require('node:fs');

const UploadedFile = require('../models/UploadedFile');
const EmailLogEntry = require('../models/EmailLogEntry');
// workprocess/queue exports the Bull queue itself, not a named property.
const emailQueue = require('../workprocess/queue');

let server;
let baseUrl;
let redis;

function buildTestApp() {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use((req, res, next) => {
    req.user = { email: 'tester@example.com', name: 'Tester' };
    next();
  });
  app.use('/', require('../routes/sendemails'));
  return app;
}

async function uploadFile(rows, filename, sessionId) {
  const form = new FormData();
  form.append('file', new Blob([rows.join('\n')], { type: 'text/csv' }), filename);

  const res = await fetch(`${baseUrl}/recipients`, {
    method: 'POST',
    body: form,
    headers: { 'x-session-id': sessionId }
  });
  return res.json();
}

/** Submits a bulk campaign over the given file ids. SMTP is unreachable by design. */
async function sendBulk(fileIds) {
  const body = new URLSearchParams({
    'smtp-host': '127.0.0.1', 'smtp-port': '2525',
    'smtp-user': 'u@example.com', 'smtp-pass': 'p',
    'smtp-from-email': 'u@example.com', 'smtp-from-name': 'Sender',
    subject: 'Identity wiring', 'test-bulk': 'Bulk',
    'message-type': 'Plain', message: 'body',
    'file-ids': fileIds.join(','), limit: '100'
  });

  const res = await fetch(`${baseUrl}/send-email`, { method: 'POST', body });
  return { status: res.status, body: await res.json() };
}

/**
 * The recipient-identifying data of every queued job belonging to `ownerIds`, in
 * enqueue order.
 *
 * Filtered by owner rather than emptying the queue between tests. Bull keeps its job
 * id counter and list keys in Redis, so flushing the database underneath a live queue
 * leaves the client unable to read back what it just wrote — the queue has to be left
 * alone for the lifetime of the file, and each test given its own session ids.
 */
async function queuedSends(ownerIds) {
  const owners = new Set(ownerIds);
  const jobs = await emailQueue.getJobs(['waiting', 'delayed', 'active'], 0, 2000);

  // Deduped on the Bull job id. getJobs() concatenates one lookup per state, and a
  // job can be picked up by more than one of them, which would otherwise report every
  // send twice — an artefact of the query, not of the enqueue.
  const byJobId = new Map();
  for (const job of jobs) {
    if (!job || !job.data) continue;
    if (!owners.has(job.data.originalSessionId)) continue;
    byJobId.set(String(job.id), job);
  }

  return [...byJobId.values()]
    .sort((a, b) => Number(a.id) - Number(b.id))
    .map((j) => ({
      email: j.data.email,
      sendId: j.data.sendId,
      originalSessionId: j.data.originalSessionId
    }));
}

/**
 * Polls until `expected` jobs for `ownerIds` are queued.
 *
 * /send-email answers `{ status: 'enqueued' }` and then does the enqueueing inside a
 * setImmediate, so the response arriving does not mean the jobs exist yet. Reading
 * once immediately after it found nothing.
 */
async function waitForSends(ownerIds, expected, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let sends = [];

  while (Date.now() < deadline) {
    sends = await queuedSends(ownerIds);
    if (sends.length >= expected) return sends;
    await new Promise((resolve) => setTimeout(resolve, 60));
  }

  return sends;
}

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
  // Redis and the queue are deliberately left intact — see queuedSends().
});

/* ================================================================== *
 * Every enqueued job carries its own identity.
 * ================================================================== */

test('each duplicate occurrence is enqueued with its own sendId', async () => {
  const fileId = testSessionId('wiring-dupes');
  await uploadFile(
    ['bob@example.com', 'bob@example.com', 'bob@example.com', 'alice@example.com'],
    'a.csv', fileId
  );

  const { body } = await sendBulk([fileId]);
  assert.equal(body.status, 'enqueued');
  assert.equal(body.batchCount, 4);

  const sends = await waitForSends([fileId], 4);

  assert.equal(sends.length, 4, 'four entries produce four jobs');
  assert.deepEqual(sends.map((s) => s.email), [
    'bob@example.com', 'bob@example.com', 'bob@example.com', 'alice@example.com'
  ]);
  assert.deepEqual(sends.map((s) => s.sendId), [
    `${fileId}#0`, `${fileId}#1`, `${fileId}#2`, `${fileId}#3`
  ]);
  assert.equal(new Set(sends.map((s) => s.sendId)).size, 4,
    'three sends to bob are three distinct identities');
});

test('sendIds are scoped per file, so two files never collide', async () => {
  const fileA = testSessionId('wiring-A');
  const fileB = testSessionId('wiring-B');

  await uploadFile(['bob@example.com', 'bob@example.com'], 'a.csv', fileA);
  await uploadFile(['bob@example.com', 'alice@example.com'], 'b.csv', fileB);

  const { body } = await sendBulk([fileA, fileB]);
  assert.equal(body.batchCount, 4);

  const sends = await waitForSends([fileA, fileB], 4);

  assert.deepEqual(sends.map((s) => s.sendId), [
    `${fileA}#0`, `${fileA}#1`, `${fileB}#0`, `${fileB}#1`
  ]);
  assert.equal(new Set(sends.map((s) => s.sendId)).size, 4);

  // Attribution still follows the entry, not the address.
  assert.deepEqual(sends.map((s) => s.originalSessionId), [fileA, fileA, fileB, fileB]);
  assert.equal(sends.filter((s) => s.email === 'bob@example.com').length, 3);
});

test('a campaign without duplicates is enqueued exactly as before', async () => {
  const fileId = testSessionId('wiring-plain');
  await uploadFile(['a@example.com', 'b@example.com', 'c@example.com'], 'a.csv', fileId);

  const { body } = await sendBulk([fileId]);
  assert.equal(body.batchCount, 3);

  const sends = await waitForSends([fileId], 3);
  assert.deepEqual(sends.map((s) => s.email), ['a@example.com', 'b@example.com', 'c@example.com']);
  assert.deepEqual(sends.map((s) => s.sendId), [`${fileId}#0`, `${fileId}#1`, `${fileId}#2`]);
});

test('test-mode sends also carry an identity, and repeats stay separate', async () => {
  // An explicit sessionId, so the jobs this test enqueues can be told apart from
  // every other test's without disturbing the shared queue.
  const testSession = `test-${testSessionId('mode')}`;

  const body = new URLSearchParams({
    'smtp-host': '127.0.0.1', 'smtp-port': '2525',
    'smtp-user': 'u@example.com', 'smtp-pass': 'p',
    'smtp-from-email': 'u@example.com', 'smtp-from-name': 'Sender',
    subject: 'Test mode', 'test-bulk': 'Test',
    'message-type': 'Plain', message: 'body',
    'test-recp': 'bob@example.com,bob@example.com,alice@example.com',
    sessionId: testSession
  });

  const res = await fetch(`${baseUrl}/send-email`, { method: 'POST', body });
  const json = await res.json();
  assert.equal(json.status, 'enqueued');
  assert.equal(json.batchCount, 3, 'a repeated test recipient is still two separate sends');

  const sends = await waitForSends([testSession], 3);
  assert.deepEqual(sends.map((s) => s.email),
    ['bob@example.com', 'bob@example.com', 'alice@example.com']);
  assert.deepEqual(sends.map((s) => s.sendId),
    [`${testSession}#0`, `${testSession}#1`, `${testSession}#2`]);
  assert.equal(new Set(sends.map((s) => s.sendId)).size, 3, 'each has its own identity');
});

/* ================================================================== *
 * Pending reconciliation is per send, not per address.
 * ================================================================== */

test('pending export marks the settled occurrence and leaves the rest', async () => {
  const fileId = testSessionId('pending-by-id');
  await uploadFile(
    ['bob@example.com', 'bob@example.com', 'bob@example.com', 'alice@example.com'],
    'a.csv', fileId
  );

  // The middle of bob's three sends completed.
  await EmailLogEntry.create({
    sessionId: fileId, campaignId: fileId,
    email: 'bob@example.com', sendId: `${fileId}#1`, status: 'sent'
  });

  const res = await fetch(`${baseUrl}/files/${encodeURIComponent(fileId)}/pending`);
  const lines = (await res.text()).split('\n').map((l) => l.trim()).filter(Boolean).slice(1);

  assert.deepEqual(lines, ['bob@example.com', 'bob@example.com', 'alice@example.com'],
    'the other two sends to bob are still outstanding');
});

test('pending export still works for rows written before sendId existed', async () => {
  const fileId = testSessionId('pending-legacy');
  await uploadFile(
    ['bob@example.com', 'bob@example.com', 'bob@example.com', 'alice@example.com'],
    'a.csv', fileId
  );

  // No sendId: one of bob's sends completed, but we cannot say which.
  await EmailLogEntry.create({
    sessionId: fileId, campaignId: fileId, email: 'bob@example.com', status: 'sent'
  });

  const res = await fetch(`${baseUrl}/files/${encodeURIComponent(fileId)}/pending`);
  const lines = (await res.text()).split('\n').map((l) => l.trim()).filter(Boolean).slice(1);

  assert.equal(lines.filter((e) => e === 'bob@example.com').length, 2,
    'falls back to counting, which is still multiplicity-correct');
  assert.ok(lines.includes('alice@example.com'));
});

test('identified and legacy log rows can be mixed', async () => {
  const fileId = testSessionId('pending-mixed');
  await uploadFile(
    ['bob@example.com', 'bob@example.com', 'bob@example.com', 'alice@example.com'],
    'a.csv', fileId
  );

  await EmailLogEntry.create([
    { sessionId: fileId, campaignId: fileId, email: 'bob@example.com', sendId: `${fileId}#0`, status: 'sent' },
    { sessionId: fileId, campaignId: fileId, email: 'bob@example.com', status: 'failed' }
  ]);

  const res = await fetch(`${baseUrl}/files/${encodeURIComponent(fileId)}/pending`);
  const lines = (await res.text()).split('\n').map((l) => l.trim()).filter(Boolean).slice(1);

  assert.deepEqual(lines, ['bob@example.com', 'alice@example.com'],
    'two of bob\'s three sends are accounted for, one by id and one by count');
});

test('EmailLogEntry.sendId is indexed but not unique, so duplicates can both log', async () => {
  const fileId = testSessionId('log-not-unique');

  // A unique index here would silently prevent the second send to a duplicated
  // recipient from being recorded — deduplication through the back door.
  await EmailLogEntry.create([
    { sessionId: fileId, campaignId: fileId, email: 'bob@example.com', sendId: `${fileId}#0`, status: 'sent' },
    { sessionId: fileId, campaignId: fileId, email: 'bob@example.com', sendId: `${fileId}#1`, status: 'sent' }
  ]);

  // Retries mean one send can legitimately produce more than one row.
  await EmailLogEntry.create({
    sessionId: fileId, campaignId: fileId, email: 'bob@example.com', sendId: `${fileId}#0`, status: 'failed'
  });

  assert.equal(await EmailLogEntry.countDocuments({ sessionId: fileId }), 3);
});
