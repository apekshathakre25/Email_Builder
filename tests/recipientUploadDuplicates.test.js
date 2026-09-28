/**
 * POST /recipients must keep every entry in an uploaded list, repeats included.
 *
 * The behaviour these tests lock in: a recipient list is a list of sends, not a set
 * of people. A file with 16 rows covering 4 distinct addresses is a request for 16
 * emails. The upload handler used to collapse it to the 4 distinct addresses, so 12
 * sends the operator had asked for were silently discarded and the file showed a
 * count of 4.
 *
 * Duplicates were dropped in two places and both had to go, which is why the send
 * side is asserted here too: keeping 16 at upload time was pointless while
 * /send-email still reduced the same list to 4 before enqueuing it.
 *
 * What must NOT change, and is asserted alongside: invalid addresses are still
 * rejected and counted separately, and each entry is still trimmed and lower-cased.
 * That is normalisation of one entry, not deduplication across entries.
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

let server;
let baseUrl;
let redis;

function buildTestApp() {
  const app = express();

  // The router is mounted behind authenticateToken in app.js and reads
  // req.user.email; this stands in for that without involving JWTs.
  app.use((req, res, next) => {
    req.user = { email: 'tester@example.com', name: 'Tester' };
    next();
  });

  app.use('/', require('../routes/sendemails'));
  return app;
}

/** Uploads `content` as `filename` under a caller-chosen session id. */
async function upload(content, filename, sessionId) {
  const form = new FormData();
  form.append('file', new Blob([content], { type: 'text/csv' }), filename);

  const res = await fetch(`${baseUrl}/recipients`, {
    method: 'POST',
    body: form,
    headers: { 'x-session-id': sessionId }
  });

  return { status: res.status, body: await res.json() };
}

const storedList = (sessionId) => redis.lrange(`recipients:${sessionId}`, 0, -1);

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
  // The handler moves each upload into uploads/ under its own name; remove them so
  // the suite leaves nothing behind.
  const files = await UploadedFile.find({}, 'storedPath').lean();
  for (const { storedPath } of files) {
    if (storedPath && fs.existsSync(storedPath)) fs.unlinkSync(storedPath);
  }

  await clearCollections();
  await clearTestRedisKeys();
});

/* ------------------------------------------------------------------ *
 * The requirement: 16 rows in, 16 retained.
 * ------------------------------------------------------------------ */

test('a CSV of 16 entries across 4 addresses retains all 16', async () => {
  const distinct = ['a@example.com', 'b@example.com', 'c@example.com', 'd@example.com'];

  // 16 rows, each address four times, interleaved so the fix cannot be faked by
  // simply keeping runs of adjacent repeats.
  const rows = [];
  for (let i = 0; i < 4; i++) rows.push(...distinct);
  assert.equal(rows.length, 16, 'fixture must have 16 entries');
  assert.equal(new Set(rows).size, 4, 'fixture must really contain duplicates');

  const sessionId = testSessionId('dupes-16');
  const { status, body } = await upload(rows.join('\n'), 'list.csv', sessionId);

  assert.equal(status, 200);
  assert.equal(body.total, 16, 'the response must report all 16 entries, not 4');

  const record = await UploadedFile.findOne({ sessionId }).lean();
  assert.ok(record, 'the upload must be recorded');
  assert.equal(record.totalEmails, 16, 'totalEmails must count every entry read');
  assert.equal(record.validEmails, 16, 'validEmails must not be the distinct count');
  assert.equal(record.pendingEmails, 16, 'all 16 must be pending, so all 16 can be sent');
  assert.equal(record.invalidEmails, 0);

  const stored = await storedList(sessionId);
  assert.equal(stored.length, 16, 'the stored recipient list must hold 16 entries');
  assert.equal(new Set(stored).size, 4, 'and still cover the 4 distinct addresses');
  assert.deepEqual(stored, rows, 'order and repeats must be preserved exactly');
});

test('every distinct address appears exactly as many times as it was listed', async () => {
  const rows = [
    'repeat@example.com', 'once@example.com', 'repeat@example.com',
    'twice@example.com', 'repeat@example.com', 'twice@example.com'
  ];

  const sessionId = testSessionId('dupes-counts');
  const { body } = await upload(rows.join('\n'), 'list.csv', sessionId);
  assert.equal(body.total, 6);

  const stored = await storedList(sessionId);
  const tally = stored.reduce((acc, e) => ({ ...acc, [e]: (acc[e] || 0) + 1 }), {});

  assert.deepEqual(tally, {
    'repeat@example.com': 3,
    'once@example.com': 1,
    'twice@example.com': 2
  });
});

test('duplicates are retained in .txt uploads too, not just .csv', async () => {
  const rows = ['x@example.com', 'x@example.com', 'y@example.com'];

  const sessionId = testSessionId('dupes-txt');
  const { body } = await upload(rows.join('\n'), 'list.txt', sessionId);

  assert.equal(body.total, 3, 'the dedup was in the shared validation loop, not the CSV parser');
  assert.equal((await storedList(sessionId)).length, 3);
});

/* ------------------------------------------------------------------ *
 * Everything else about the upload must be unchanged.
 * ------------------------------------------------------------------ */

test('invalid addresses are still rejected while duplicates are kept', async () => {
  const rows = [
    'good@example.com', 'good@example.com',   // kept twice
    'not-an-email',                            // rejected
    'also bad @ example',                      // rejected
    'other@example.com'
  ];

  const sessionId = testSessionId('dupes-invalid');
  const { body } = await upload(rows.join('\n'), 'list.csv', sessionId);

  assert.equal(body.total, 3, 'three valid entries, one of them a repeat');
  assert.equal(body.fileInfo.validEmails, 3);
  assert.equal(body.fileInfo.invalidEmails, 2, 'invalid entries are still filtered out');

  const record = await UploadedFile.findOne({ sessionId }).lean();
  assert.equal(record.validEmails, 3);
  assert.equal(record.invalidEmails, 2);
  assert.equal(record.totalEmails, 5, 'every entry read, valid or not');

  const stored = await storedList(sessionId);
  assert.deepEqual(stored, ['good@example.com', 'good@example.com', 'other@example.com']);
});

test('entries are still trimmed and lower-cased, which is not deduplication', async () => {
  // The same address written three ways. All three are kept, because normalising
  // each entry is not the same as collapsing entries that match after normalising.
  const rows = ['  Mixed@Example.COM  ', 'mixed@example.com', 'MIXED@EXAMPLE.COM'];

  const sessionId = testSessionId('dupes-normalise');
  const { body } = await upload(rows.join('\n'), 'list.csv', sessionId);

  assert.equal(body.total, 3);
  assert.deepEqual(await storedList(sessionId), [
    'mixed@example.com', 'mixed@example.com', 'mixed@example.com'
  ]);
});

test('a list with no duplicates is unaffected', async () => {
  const rows = Array.from({ length: 16 }, (_, i) => `user${i}@example.com`);

  const sessionId = testSessionId('no-dupes');
  const { body } = await upload(rows.join('\n'), 'list.csv', sessionId);

  assert.equal(body.total, 16);
  assert.deepEqual(await storedList(sessionId), rows);
});

test('blank lines are still skipped rather than counted as entries', async () => {
  const sessionId = testSessionId('dupes-blanks');
  const { body } = await upload(
    'a@example.com\n\n\na@example.com\n\n', 'list.csv', sessionId
  );

  assert.equal(body.total, 2, 'two real entries, both kept; empty lines are not entries');
  assert.deepEqual(await storedList(sessionId), ['a@example.com', 'a@example.com']);
});

/* ------------------------------------------------------------------ *
 * The send side must not put the deduplication back.
 * ------------------------------------------------------------------ */

test('the stored list a campaign reads back still contains every duplicate', async () => {
  // getRecipients() is what POST /send-email builds its recipient list from. If this
  // ever returns the distinct set again, the 16 retained above could never be sent.
  const rows = Array.from({ length: 16 }, (_, i) => `dup${i % 4}@example.com`);

  const sessionId = testSessionId('dupes-readback');
  await upload(rows.join('\n'), 'list.csv', sessionId);

  const readBack = await storedList(sessionId);
  assert.equal(readBack.length, 16, 'the send path must see 16 recipients, not 4');
  assert.equal(new Set(readBack).size, 4);
});
