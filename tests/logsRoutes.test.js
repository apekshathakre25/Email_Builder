/**
 * Regression tests for the campaign-log delete endpoints in routes/sendemails.js.
 *
 * The bug: `DELETE /logs` built its response from `result.deletedCount` without
 * ever declaring `result`. The deletes ran, then the template literal threw a
 * ReferenceError, so the catch returned 500. Callers were told the wipe failed
 * while the data was already gone — the worst possible pairing, because the
 * obvious response is to retry.
 *
 * These tests pin the endpoints' observable behaviour: a 2xx with real counts on
 * success, 404 for an unknown session, and the correct Redis keys removed (and,
 * just as importantly, the ones that must survive).
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

const EmailLog = require('../models/EmailLog');
const EmailLogEntry = require('../models/EmailLogEntry');
const { recipientsKey, sentIndexKey, emailLogKey } = require('../utils/sessionKeys');

let server;
let baseUrl;
let redis;

function buildTestApp() {
  const app = express();
  app.use(express.json());

  // The router is mounted behind authenticateToken in app.js and reads
  // req.user.email; this stands in for that without involving JWTs.
  app.use((req, res, next) => {
    req.user = { email: 'tester@example.com', name: 'Tester' };
    next();
  });

  app.use('/', require('../routes/sendemails'));
  return app;
}

async function seedCampaign(sessionId, { entries = 3 } = {}) {
  await EmailLog.create({
    sessionId,
    fromEmail: 'from@example.com',
    subject: 'Subject',
    totalRecipients: entries,
    status: 'completed'
  });

  await EmailLogEntry.insertMany(
    Array.from({ length: entries }, (_, i) => ({
      sessionId,
      campaignId: sessionId,
      email: `r${i}@example.com`,
      status: 'sent'
    }))
  );

  await redis.rpush(emailLogKey(sessionId), JSON.stringify({ email: 'r0@example.com' }));
  await redis.rpush(recipientsKey(sessionId), 'r0@example.com');
  await redis.set(sentIndexKey(sessionId), '3');
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
  await clearTestRedisKeys();
  await stopTestDb();
});

test.beforeEach(async () => {
  await clearCollections();
  await clearTestRedisKeys();
});

test('DELETE /logs succeeds and reports real counts (regression: ReferenceError returned 500)', async () => {
  await seedCampaign(testSessionId('wipe-a'), { entries: 3 });
  await seedCampaign(testSessionId('wipe-b'), { entries: 2 });

  const response = await fetch(`${baseUrl}/logs`, { method: 'DELETE' });
  const body = await response.json();

  assert.equal(response.status, 200, 'must not return 500 after a successful delete');
  assert.equal(body.success, true);
  assert.equal(body.deletedLogs, 2);
  assert.equal(body.deletedEntries, 5);
  assert.match(body.message, /All 2 logs/);
  assert.equal(body.error, undefined);

  assert.equal(await EmailLog.countDocuments({}), 0);
  assert.equal(await EmailLogEntry.countDocuments({}), 0);
});

test('DELETE /logs on an empty collection reports zero rather than failing', async () => {
  const response = await fetch(`${baseUrl}/logs`, { method: 'DELETE' });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.equal(body.deletedLogs, 0);
  assert.equal(body.deletedEntries, 0);
});

test('DELETE /logs clears emaillog trails but keeps recipient lists and sent indexes', async () => {
  const id = testSessionId('wipe-keys');
  await seedCampaign(id);

  const response = await fetch(`${baseUrl}/logs`, { method: 'DELETE' });
  assert.equal(response.status, 200);

  assert.equal(await redis.exists(emailLogKey(id)), 0, 'log trail should be removed');
  assert.equal(
    await redis.exists(recipientsKey(id)),
    1,
    'recipient list belongs to the file, not the log, and must survive'
  );
  assert.equal(
    await redis.exists(sentIndexKey(id)),
    1,
    'resetting the sent index would cause the campaign to re-send from zero'
  );
});

test('DELETE /logs/:sessionId removes one campaign and its entries', async () => {
  const keep = testSessionId('keep');
  const drop = testSessionId('drop');
  await seedCampaign(keep, { entries: 2 });
  await seedCampaign(drop, { entries: 4 });

  const response = await fetch(`${baseUrl}/logs/${drop}`, { method: 'DELETE' });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.equal(body.deletedLogs, 1);
  assert.equal(body.deletedEntries, 4);

  assert.equal(await EmailLog.countDocuments({ sessionId: drop }), 0);
  assert.equal(await EmailLogEntry.countDocuments({ campaignId: drop }), 0);
  assert.equal(await EmailLog.countDocuments({ sessionId: keep }), 1, 'other campaigns untouched');
  assert.equal(await EmailLogEntry.countDocuments({ campaignId: keep }), 2);

  assert.equal(await redis.exists(emailLogKey(drop)), 0);
  assert.equal(await redis.exists(recipientsKey(drop)), 1, 'file-owned key must survive');
});

test('DELETE /logs/:sessionId returns 404 for an unknown session', async () => {
  const response = await fetch(`${baseUrl}/logs/${testSessionId('does-not-exist')}`, {
    method: 'DELETE'
  });
  const body = await response.json();

  assert.equal(response.status, 404);
  assert.equal(body.error, 'Log not found');
});
