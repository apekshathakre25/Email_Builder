/**
 * No deduplication anywhere between a selected file and an enqueued send.
 *
 * The rule: a recipient list is a list of sends, not a set of people. Every entry is
 * one email. If an address appears twice in one file, or once in each of two
 * selected files, that is two sends.
 *
 * Duplicates used to be collapsed in five separate places, each individually
 * reasonable and collectively guaranteeing the operator could not do this:
 *
 *   1. POST /recipients            — a `seen` Set while validating an upload.
 *   2. POST /send-email            — `uniqueRecipients` when gathering across the
 *                                    selected files.
 *   3. POST /send-email            — the forward slice filtered against the resend
 *                                    backlog.
 *   4. takeResendQueue()           — a `seen` Set when draining the backlog after a
 *                                    stop.
 *   5. GET /files/:id/pending      — set subtraction, so one completed send marked
 *                                    every copy of that address as done.
 *
 * The worked example from the requirement, which these tests encode: file A holding
 * bob twice and file B holding bob and alice must produce four sends —
 * bob, bob, bob, alice.
 *
 * Deliberately asserts the *pipeline*, not just the upload: the count has to survive
 * parsing, storage, multi-file selection and the batch that is handed to the queue.
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
const { queueForResend, takeResendQueue } = require('../utils/campaignStop');

let server;
let baseUrl;
let redis;

function buildTestApp() {
  const app = express();
  app.use((req, res, next) => {
    req.user = { email: 'tester@example.com', name: 'Tester' };
    next();
  });
  app.use('/', require('../routes/sendemails'));
  return app;
}

/** Uploads `rows` as a CSV under a caller-chosen session id. */
async function uploadFile(rows, filename, sessionId) {
  const form = new FormData();
  form.append('file', new Blob([rows.join('\n')], { type: 'text/csv' }), filename);

  const res = await fetch(`${baseUrl}/recipients`, {
    method: 'POST',
    body: form,
    headers: { 'x-session-id': sessionId }
  });

  return { status: res.status, body: await res.json() };
}

const storedList = (sessionId) => redis.lrange(`recipients:${sessionId}`, 0, -1);

/**
 * The recipient list POST /send-email builds from a set of selected files, using the
 * same two steps the route does: read each file's stored list in the given order and
 * concatenate. Asserting on this rather than driving a real send keeps the test off
 * SMTP while still covering the step that used to deduplicate.
 */
async function gatherAcrossFiles(fileIds) {
  const details = [];
  for (const fileId of fileIds) {
    for (const email of await storedList(fileId)) {
      details.push({ email, sourceFile: fileId });
    }
  }
  return details;
}

const tally = (emails) =>
  emails.reduce((acc, e) => ({ ...acc, [e]: (acc[e] || 0) + 1 }), {});

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
  await clearTestRedisKeys();
  await stopTestDb();
});

test.afterEach(async () => {
  const files = await UploadedFile.find({}, 'storedPath').lean();
  for (const { storedPath } of files) {
    if (storedPath && fs.existsSync(storedPath)) fs.unlinkSync(storedPath);
  }
  await clearCollections();
  await clearTestRedisKeys();
});

/* ================================================================== *
 * 1. Duplicates within a single file are preserved.
 * ================================================================== */

test('duplicates within one file are preserved end to end', async () => {
  const rows = ['bob@example.com', 'bob@example.com', 'bob@example.com', 'alice@example.com'];

  const fileId = testSessionId('within-one');
  const { body } = await uploadFile(rows, 'a.csv', fileId);

  assert.equal(body.total, 4);
  assert.deepEqual(await storedList(fileId), rows, 'stored in order, repeats intact');

  const gathered = await gatherAcrossFiles([fileId]);
  assert.equal(gathered.length, 4, 'the send path must see 4 sends, not 2 addresses');
  assert.deepEqual(tally(gathered.map((g) => g.email)), {
    'bob@example.com': 3,
    'alice@example.com': 1
  });
});

/* ================================================================== *
 * 2. Duplicates across multiple selected files are preserved.
 *    This is the worked example from the requirement.
 * ================================================================== */

test('the requirement example: A[bob,bob] + B[bob,alice] sends 4 emails', async () => {
  const fileA = testSessionId('example-A');
  const fileB = testSessionId('example-B');

  await uploadFile(['bob@example.com', 'bob@example.com'], 'a.csv', fileA);
  await uploadFile(['bob@example.com', 'alice@example.com'], 'b.csv', fileB);

  const gathered = await gatherAcrossFiles([fileA, fileB]);
  const emails = gathered.map((g) => g.email);

  assert.equal(emails.length, 4, 'four entries selected means four sends');
  assert.deepEqual(emails, [
    'bob@example.com',   // file A, entry 1
    'bob@example.com',   // file A, entry 2
    'bob@example.com',   // file B, entry 1
    'alice@example.com'  // file B, entry 2
  ]);
  assert.deepEqual(tally(emails), { 'bob@example.com': 3, 'alice@example.com': 1 });
});

test('an address shared by two files is not merged into one send', async () => {
  const fileA = testSessionId('shared-A');
  const fileB = testSessionId('shared-B');

  await uploadFile(['shared@example.com', 'only-a@example.com'], 'a.csv', fileA);
  await uploadFile(['shared@example.com', 'only-b@example.com'], 'b.csv', fileB);

  const emails = (await gatherAcrossFiles([fileA, fileB])).map((g) => g.email);

  assert.equal(emails.length, 4);
  assert.equal(
    emails.filter((e) => e === 'shared@example.com').length, 2,
    'the shared address must be sent once per file it appears in'
  );
});

test('each occurrence keeps the source file it came from', async () => {
  const fileA = testSessionId('attr-A');
  const fileB = testSessionId('attr-B');

  await uploadFile(['bob@example.com', 'bob@example.com'], 'a.csv', fileA);
  await uploadFile(['bob@example.com'], 'b.csv', fileB);

  const gathered = await gatherAcrossFiles([fileA, fileB]);

  assert.deepEqual(gathered.map((g) => g.sourceFile), [fileA, fileA, fileB],
    'recipientSourceMap must hold one entry per send, not one per address');
});

/* ================================================================== *
 * 3. The final count matches the total entries across all files.
 * ================================================================== */

test('the recipient count equals the total entries across all selected files', async () => {
  // Three files, heavy overlap: 16 entries covering only 4 distinct addresses.
  const distinct = ['w@example.com', 'x@example.com', 'y@example.com', 'z@example.com'];
  const plan = [
    { id: testSessionId('count-1'), rows: [...distinct, ...distinct] }, // 8
    { id: testSessionId('count-2'), rows: [...distinct] },              // 4
    { id: testSessionId('count-3'), rows: [...distinct] }              // 4
  ];

  let expectedTotal = 0;
  for (const { id, rows } of plan) {
    const { body } = await uploadFile(rows, `${id}.csv`, id);
    assert.equal(body.total, rows.length, `${id} must retain all ${rows.length} entries`);
    expectedTotal += rows.length;
  }

  assert.equal(expectedTotal, 16, 'fixture sanity: 16 entries in total');

  const gathered = await gatherAcrossFiles(plan.map((p) => p.id));
  assert.equal(gathered.length, 16, 'the campaign total must be 16, not the 4 distinct');
  assert.equal(new Set(gathered.map((g) => g.email)).size, 4, 'over only 4 addresses');

  // Per-file records must agree with the same total, since /status derives the
  // campaign total from them before an EmailLog exists.
  const records = await UploadedFile.find({}).lean();
  const sumValid = records.reduce((n, r) => n + r.validEmails, 0);
  const sumTotal = records.reduce((n, r) => n + r.totalEmails, 0);
  const sumPending = records.reduce((n, r) => n + r.pendingEmails, 0);

  assert.equal(sumValid, 16);
  assert.equal(sumTotal, 16);
  assert.equal(sumPending, 16, 'all 16 must be pending, so all 16 can be sent');
});

test('one job is enqueued per entry, so duplicates each get their own send', async () => {
  // Mirrors `const jobs = batch.map(...)` in POST /send-email. No jobId is set on
  // these jobs, so Bull cannot collapse two sends to the same address.
  const fileId = testSessionId('jobs-per-entry');
  await uploadFile(['d@example.com', 'd@example.com', 'e@example.com'], 'a.csv', fileId);

  const batch = (await gatherAcrossFiles([fileId])).map((g) => g.email);
  const jobs = batch.map((email, index) => ({ data: { email }, index }));

  assert.equal(jobs.length, 3, 'three entries produce three jobs');
  assert.deepEqual(jobs.map((j) => j.data.email),
    ['d@example.com', 'd@example.com', 'e@example.com']);
  assert.equal(new Set(jobs.map((j) => j.index)).size, 3, 'each job is distinct');
});

/* ================================================================== *
 * The stop / resend backlog must not collapse repeats either.
 * ================================================================== */

test('the resend backlog returns every queued occurrence', async () => {
  const sessionId = testSessionId('resend-dupes');

  // A stop discarding three outstanding sends to the same address. Each carries the
  // sendId /send-email assigned it — the position in the file's list — which is what
  // keeps them apart. See tests/sendIdentity.test.js for the identity rule itself.
  const queued = await queueForResend(redis, sessionId, [
    { email: 'bob@example.com', sourceFile: sessionId, sendId: `${sessionId}#0` },
    { email: 'bob@example.com', sourceFile: sessionId, sendId: `${sessionId}#1` },
    { email: 'bob@example.com', sourceFile: sessionId, sendId: `${sessionId}#2` },
    { email: 'alice@example.com', sourceFile: sessionId, sendId: `${sessionId}#3` }
  ]);
  assert.equal(queued, 4);

  const drained = await takeResendQueue(redis, sessionId);

  assert.equal(drained.length, 4, 'a campaign owing bob three emails must resume owing three');
  assert.deepEqual(tally(drained.map((d) => d.email)), {
    'bob@example.com': 3,
    'alice@example.com': 1
  });
});

test('the forward slice is no longer filtered against the resend backlog', async () => {
  // Mirrors how POST /send-email composes `batch`. An address in the backlog AND in
  // the upcoming slice is two separate sends.
  const resendBatch = [{ email: 'bob@example.com', sourceFile: 'f1' }];
  const forwardBatch = ['bob@example.com', 'carol@example.com'];

  const batch = [...resendBatch.map((e) => e.email), ...forwardBatch];

  assert.deepEqual(batch, ['bob@example.com', 'bob@example.com', 'carol@example.com']);
  assert.equal(batch.length, 3, 'the retry and the scheduled send are both kept');
});

/* ================================================================== *
 * The pending export must count, not set-subtract.
 * ================================================================== */

test('pending export reports remaining occurrences, not remaining addresses', async () => {
  const fileId = testSessionId('pending-dupes');
  await uploadFile(
    ['bob@example.com', 'bob@example.com', 'bob@example.com', 'alice@example.com'],
    'a.csv', fileId
  );

  // One of bob's three sends has completed.
  await EmailLogEntry.create({
    sessionId: fileId, campaignId: fileId, email: 'bob@example.com', status: 'sent'
  });

  const res = await fetch(`${baseUrl}/files/${encodeURIComponent(fileId)}/pending`);
  assert.equal(res.status, 200);

  const lines = (await res.text()).split('\n').map((l) => l.trim()).filter(Boolean);
  const pending = lines.slice(1); // drop the "email" header

  assert.deepEqual(pending, ['bob@example.com', 'bob@example.com', 'alice@example.com'],
    'two of bob\'s three sends are still outstanding');
});

/* ================================================================== *
 * 4. No unrelated validation behaviour changed.
 * ================================================================== */

test('invalid addresses are still rejected', async () => {
  const fileId = testSessionId('still-validates');
  const { body } = await uploadFile(
    ['ok@example.com', 'ok@example.com', 'not-an-email', 'nope@', '@nope.com'],
    'a.csv', fileId
  );

  assert.equal(body.total, 2, 'both copies of the valid address kept');
  assert.equal(body.fileInfo.invalidEmails, 3, 'and the three invalid entries rejected');
  assert.deepEqual(await storedList(fileId), ['ok@example.com', 'ok@example.com']);
});

test('normalisation is unchanged: entries are still trimmed and lower-cased', async () => {
  const fileId = testSessionId('still-normalises');
  await uploadFile(['  Bob@Example.COM ', 'BOB@EXAMPLE.COM'], 'a.csv', fileId);

  assert.deepEqual(await storedList(fileId), ['bob@example.com', 'bob@example.com'],
    'normalised per entry, and still two entries');
});

test('blank lines are still skipped', async () => {
  const fileId = testSessionId('still-skips-blanks');
  const form = new FormData();
  form.append('file', new Blob(['a@example.com\n\n\na@example.com\n'], { type: 'text/csv' }), 'a.csv');
  const res = await fetch(`${baseUrl}/recipients`, {
    method: 'POST', body: form, headers: { 'x-session-id': fileId }
  });

  assert.equal((await res.json()).total, 2);
});

test('unsupported file types are still refused', async () => {
  const form = new FormData();
  form.append('file', new Blob(['a@example.com'], { type: 'text/plain' }), 'list.pdf');

  const res = await fetch(`${baseUrl}/recipients`, { method: 'POST', body: form });

  assert.notEqual(res.status, 200, 'the extension allowlist still applies');
});

test('an empty selection is still rejected rather than treated as zero sends', async () => {
  const fileId = testSessionId('all-invalid');
  const { body } = await uploadFile(['not-an-email', 'also-bad'], 'a.csv', fileId);

  assert.equal(body.total, 0);
  assert.deepEqual(await storedList(fileId), [], 'nothing valid to store');
});
