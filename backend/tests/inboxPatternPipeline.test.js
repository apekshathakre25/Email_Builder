'use strict';

// Required first: isolates every Redis key used by the routes and Bull queue.
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
const path = require('node:path');

const EmailLog = require('../models/EmailLog');
const UploadedFile = require('../models/UploadedFile');
const emailQueue = require('../workprocess/queue');
const campaignQueue = require('../utils/campaignQueue');
const { renderInboxPattern } = require('../services/inboxPatternRenderer');

const USER = 'pattern-tester@example.com';
let server;
let baseUrl;
let redis;

function buildTestApp() {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = { email: USER, name: 'Pattern Tester' };
    next();
  });
  app.use('/', require('../routes/campaignQueue'));
  app.use('/', require('../routes/sendemails'));
  return app;
}

async function postJson(route, body) {
  const response = await fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

async function uploadRecipient(fileId, email = 'recipient@example.com') {
  const form = new FormData();
  form.append('file', new Blob([email], { type: 'text/csv' }), `${fileId}.csv`);
  const response = await fetch(`${baseUrl}/recipients`, {
    method: 'POST',
    headers: { 'x-session-id': fileId },
    body: form
  });
  assert.equal(response.status, 200);
}

function sendBody({ fileId, patternId, testMode = false, customHeaders, customMessageId } = {}) {
  const body = new URLSearchParams({
    'smtp-host': '127.0.0.1',
    'smtp-port': '2525',
    'smtp-user': 'sender@example.com',
    'smtp-pass': 'password',
    'smtp-from-email': 'sender@example.com',
    'smtp-from-name': 'Sender Name',
    subject: 'Inbox pattern pipeline',
    'test-bulk': testMode ? 'Test' : 'Bulk',
    'plain-html': 'HTML',
    message: '<p>Hello from the pipeline</p>',
    limit: '10'
  });

  if (testMode) {
    body.set('test-recp', 'test-recipient@example.net');
    body.set('sessionId', fileId);
  } else {
    body.set('file-ids', fileId);
  }
  if (patternId !== undefined) body.set('inbox-pattern-id', patternId);
  if (customHeaders !== undefined) body.set('custom-headers', customHeaders);
  if (customMessageId !== undefined) body.set('custom-message-id', customMessageId);
  return body;
}

async function sendEmail(options) {
  const response = await fetch(`${baseUrl}/send-email`, {
    method: 'POST',
    body: sendBody(options)
  });
  return { status: response.status, body: await response.json() };
}

async function jobsFor(sessionId) {
  const jobs = await emailQueue.getJobs(['waiting', 'delayed', 'active'], 0, 2000);
  const byId = new Map();
  for (const job of jobs) {
    if (!job || !job.data || job.data.sessionId !== sessionId) continue;
    byId.set(String(job.id), job);
  }
  return [...byId.values()];
}

async function waitForJobs(sessionId, expected, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let jobs = [];
  while (Date.now() < deadline) {
    jobs = await jobsFor(sessionId);
    if (jobs.length >= expected) return jobs;
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  return jobs;
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
});

test('campaign lane rejects an unknown pattern before entering SENDING', async () => {
  const campaignId = testSessionId('pattern-lane-invalid');
  const claimed = await postJson('/campaign-lane/claim', { campaignId, total: 1 });
  assert.equal(claimed.status, 200);

  const response = await postJson('/campaign-lane/start', {
    campaignId,
    inboxPatternId: 'pattern-does-not-exist'
  });

  assert.equal(response.status, 400);
  assert.match(response.body.error, /Unknown inbox pattern/);
  assert.equal((await campaignQueue.readSlot(redis, campaignId)).state, campaignQueue.STATES.QUEUED);

  await campaignQueue.release(redis, {
    userId: USER,
    campaignId,
    state: campaignQueue.STATES.CANCELLED
  });
});

test('campaign lane accepts a valid or omitted optional pattern ID', async () => {
  const selectedId = testSessionId('pattern-lane-valid');
  await postJson('/campaign-lane/claim', { campaignId: selectedId, total: 1 });
  assert.equal((await postJson('/campaign-lane/start', {
    campaignId: selectedId,
    inboxPatternId: 'pattern-1'
  })).status, 200);

  await campaignQueue.release(redis, {
    userId: USER,
    campaignId: selectedId,
    state: campaignQueue.STATES.COMPLETED
  });

  const defaultId = testSessionId('pattern-lane-default');
  await postJson('/campaign-lane/claim', { campaignId: defaultId, total: 1 });
  assert.equal((await postJson('/campaign-lane/start', { campaignId: defaultId })).status, 200);
});

test('bulk send rejects an unknown pattern before reservation or campaign state changes', async () => {
  const fileId = testSessionId('pattern-invalid-bulk');
  await uploadRecipient(fileId);

  const response = await sendEmail({ fileId, patternId: 'pattern-404' });

  assert.equal(response.status, 400);
  assert.match(response.body.error, /Unknown inbox pattern/);
  assert.equal(await redis.get(`sentIndex:${fileId}`), null);
  assert.equal(await EmailLog.findOne({ sessionId: fileId }), null);
  assert.equal((await UploadedFile.findOne({ sessionId: fileId }).lean()).status, 'uploaded');
  assert.equal((await jobsFor(fileId)).length, 0);
});

test('test mode rejects an unknown pattern before creating state or jobs', async () => {
  const sessionId = `test-${testSessionId('pattern-invalid-test-mode')}`;
  const response = await sendEmail({
    fileId: sessionId,
    patternId: 'pattern-does-not-exist',
    testMode: true
  });

  assert.equal(response.status, 400);
  assert.match(response.body.error, /Unknown inbox pattern/);
  assert.equal(await EmailLog.findOne({ sessionId }), null);
  assert.equal((await jobsFor(sessionId)).length, 0);
});

test('valid pattern selection persists the ID and propagates it to every bulk job', async () => {
  const fileId = testSessionId('pattern-valid-bulk');
  await uploadRecipient(fileId);

  const response = await sendEmail({ fileId, patternId: 'pattern-2' });
  assert.equal(response.status, 200);
  assert.equal(response.body.status, 'enqueued');

  const log = await EmailLog.findOne({ sessionId: fileId }).lean();
  assert.equal(log.inboxPatternId, 'pattern-2');
  assert.equal('mailOptions' in log, false, 'campaigns store no profile content copy');

  const jobs = await waitForJobs(fileId, 1);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].data.inboxPatternId, 'pattern-2');
});

test('test sends persist and propagate the selected pattern ID', async () => {
  const sessionId = `test-${testSessionId('pattern-test-mode')}`;
  const response = await sendEmail({ fileId: sessionId, patternId: 'pattern-3', testMode: true });
  assert.equal(response.status, 200);

  const log = await EmailLog.findOne({ sessionId }).lean();
  assert.equal(log.inboxPatternId, 'pattern-3');

  const jobs = await waitForJobs(sessionId, 1);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].data.inboxPatternId, 'pattern-3');
});

test('selected patterns reject protected and profile-owned custom headers before reservation', async () => {
  for (const [label, options] of [
    ['protected', { customHeaders: 'Received: by forged.example' }],
    ['mime', { customHeaders: 'Content-Type: text/plain' }],
    ['message-id-header', { customHeaders: 'Message-ID: <forged@example.com>' }],
    ['message-id-field', { customMessageId: '<{{MessageId}}@{{Domain}}>' }]
  ]) {
    const fileId = testSessionId(`pattern-header-${label}`);
    await uploadRecipient(fileId);
    const response = await sendEmail({ fileId, patternId: 'pattern-1', ...options });

    assert.equal(response.status, 400, label);
    assert.match(response.body.error, /cannot be used with an Inbox Pattern/);
    assert.equal(await redis.get(`sentIndex:${fileId}`), null, label);
    assert.equal(await EmailLog.findOne({ sessionId: fileId }), null, label);
  }
});

test('omitting the pattern preserves legacy custom headers and job shape', async () => {
  const fileId = testSessionId('pattern-default-legacy');
  await uploadRecipient(fileId);

  const response = await sendEmail({
    fileId,
    customHeaders: 'Received: legacy behavior remains unchanged'
  });
  assert.equal(response.status, 200);

  const log = await EmailLog.findOne({ sessionId: fileId }).lean();
  assert.equal(log.inboxPatternId, null);

  const jobs = await waitForJobs(fileId, 1);
  assert.equal(jobs.length, 1);
  assert.equal('inboxPatternId' in jobs[0].data, false);
  assert.equal(jobs[0].data.headers.Received, 'legacy behavior remains unchanged');
});

test('old campaign documents without inboxPatternId remain readable', async () => {
  const sessionId = testSessionId('pattern-old-document');
  await EmailLog.collection.insertOne({
    sessionId,
    campaignName: 'Old campaign',
    fromEmail: 'old@example.com',
    subject: 'Before patterns',
    totalRecipients: 1,
    status: 'in_progress'
  });

  const raw = await EmailLog.collection.findOne({ sessionId });
  assert.equal('inboxPatternId' in raw, false);
  const campaign = await EmailLog.findOne({ sessionId });
  assert.equal(campaign.sessionId, sessionId);
});

test('worker path renders the selected profile at the single existing sendMail point', () => {
  const values = {
    ToEmail: 'recipient@example.net',
    ToName: '',
    FromName: 'Sender Name',
    FromEmail: 'sender@example.com',
    SubjectLine: 'Worker subject',
    MessageId: '<worker@example.com>',
    PlainContent: 'Converted HTML text',
    HtmlContent: '<p>Worker HTML</p>',
    Domain: 'example.com',
    FromDomain: 'example.com'
  };
  const options = renderInboxPattern('pattern-1', values, {
    now: new Date('2024-01-02T03:04:05Z'),
    random: () => 0
  });
  assert.equal(options.to.address, values.ToEmail);
  assert.equal(options.text.content, values.PlainContent);
  assert.equal(options.html.content, values.HtmlContent);

  const workerSource = fs.readFileSync(
    path.join(__dirname, '..', 'workprocess', 'mailer.js'),
    'utf8'
  );
  assert.match(workerSource, /if \(inboxPatternId\)[\s\S]*renderInboxPattern\(inboxPatternId/);
  assert.match(workerSource, /inboxPatternId: config\.inboxPatternId/);
  assert.equal((workerSource.match(/transporter\.sendMail\(mailOptions\)/g) || []).length, 1,
    'selected and default sends share the existing transporter call');
});
