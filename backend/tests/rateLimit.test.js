/**
 * Regression tests for the rate-limiting split in middleware/rateLimit.js.
 *
 * The incident these pin down: every route shared one 300/min/IP bucket, so
 * /status polling (1472 requests observed in production, against 7 to
 * /send-email) exhausted the allowance and POST /send-email started returning
 * 429. A refused POST enqueues nothing, so sending genuinely stopped for ~55s
 * until the window rolled over.
 *
 * The property under test is therefore not "a limit exists" but "monitoring
 * traffic cannot consume the campaign-submission allowance". Test 1 is the one
 * that would have caught the outage.
 */

// Required first: it moves Redis onto an isolated database before any module
// that builds a client at require time can be loaded.
const {
  startTestDb,
  stopTestDb,
  clearTestRedisKeys,
  getSharedRedisClient
} = require('./helpers/testDb');

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const {
  globalLimiter,
  sendLimiter,
  monitoringLimiter,
  DEDICATED_LIMITER_PATHS,
  SEND_LIMIT_PER_MINUTE,
  MONITORING_LIMIT_PER_MINUTE
} = require('../middleware/rateLimit');

let server;
let baseUrl;

/**
 * Mirrors the middleware order in app.js: dedicated buckets first, global
 * backstop after. Handlers are trivial because what is under test is which
 * limiter counts a request, not what the route does.
 */
function buildApp() {
  const app = express();

  // Matches production (TRUST_PROXY=1 -> one proxy hop, Caddy). `true` would be
  // permissive enough for a client to spoof X-Forwarded-For and bypass IP-based
  // limits, which express-rate-limit rejects as ERR_ERL_PERMISSIVE_TRUST_PROXY.
  app.set('trust proxy', 1);

  app.use('/send-email', sendLimiter);
  app.use('/status', monitoringLimiter);
  app.use('/api/system-health', monitoringLimiter);
  app.use(globalLimiter);

  app.post('/send-email', (req, res) => res.json({ status: 'enqueued', batchCount: 35 }));
  app.get('/status', (req, res) => res.json({ total: 100, sent: 10, failed: 0, sending: 5, sentIndex: 15, lastError: '' }));
  app.get('/api/system-health', (req, res) => res.json({ ok: true }));
  app.get('/logs', (req, res) => res.json({ logs: [] }));

  return app;
}

/** Distinct source IP per test, so buckets never bleed between cases. */
function req(path, { method = 'GET', ip = '203.0.113.1' } = {}) {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'X-Forwarded-For': ip }
  });
}

async function hammer(path, times, { method = 'GET', ip } = {}) {
  const codes = [];
  for (let i = 0; i < times; i++) {
    const res = await req(path, { method, ip });
    codes.push(res.status);
  }
  return codes;
}

test.before(async () => {
  await startTestDb();
  await clearTestRedisKeys();

  await new Promise((resolve) => {
    server = buildApp().listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await clearTestRedisKeys();
  getSharedRedisClient().disconnect();
  await stopTestDb();
});

test.beforeEach(async () => {
  await clearTestRedisKeys();
});

// ── Test 1 ───────────────────────────────────────────────────────────────────
// The outage, reproduced. Monitoring traffic well past the old 300/min global
// ceiling, then a send.
test('Test 1: heavy /status polling does not cause /send-email to be refused', async () => {
  const ip = '203.0.113.10';

  const statusCodes = await hammer('/status', 350, { ip });
  const refusedStatus = statusCodes.filter((c) => c === 429).length;

  // 350 is above the old shared limit of 300 and below the monitoring bucket's
  // own 600, so none of these should be refused either.
  assert.equal(refusedStatus, 0, `expected no 429 on /status within its own bucket, saw ${refusedStatus}`);

  const send = await req('/send-email', { method: 'POST', ip });
  assert.equal(send.status, 200, 'send must succeed after heavy status polling');

  const body = await send.json();
  assert.equal(body.status, 'enqueued');
});

// Same shape, but pushing monitoring until it is genuinely exhausted: the send
// must still get through, because the buckets are separate.
test('Test 1b: even an exhausted monitoring bucket leaves /send-email usable', async () => {
  const ip = '203.0.113.11';

  const codes = await hammer('/status', MONITORING_LIMIT_PER_MINUTE + 20, { ip });
  assert.ok(codes.includes(429), 'monitoring bucket should eventually refuse');

  const send = await req('/send-email', { method: 'POST', ip });
  assert.equal(send.status, 200, 'monitoring exhaustion must never block campaign submission');
});

// ── Test 2 ───────────────────────────────────────────────────────────────────
test('Test 2: realistic frontend polling plus submissions produces no 429', async () => {
  const ip = '203.0.113.20';

  // Ten minutes of the 1.5s cadence is 400 polls; add health polling at 10s
  // and a batch submitted every 5s over one minute. Compressing ten minutes of
  // polling into a single 60s window is deliberately pessimistic: the real
  // steady-state cost of one tab is ~40/min against a 600/min bucket.
  const pollCodes = await hammer('/status', 400, { ip });
  const healthCodes = await hammer('/api/system-health', 60, { ip });
  const sendCodes = await hammer('/send-email', 12, { method: 'POST', ip });

  const all = [...pollCodes, ...healthCodes, ...sendCodes];
  const refused = all.filter((c) => c === 429).length;

  assert.equal(refused, 0, `normal operation must not be rate limited, saw ${refused} refusals`);
});

// ── Test 3 ───────────────────────────────────────────────────────────────────
test('Test 3: abusive /send-email volume is still refused', async () => {
  const ip = '203.0.113.30';

  const codes = await hammer('/send-email', SEND_LIMIT_PER_MINUTE + 10, { method: 'POST', ip });

  const allowed = codes.filter((c) => c === 200).length;
  const refused = codes.filter((c) => c === 429).length;

  assert.equal(allowed, SEND_LIMIT_PER_MINUTE, 'should allow exactly the configured send budget');
  assert.ok(refused >= 1, 'excess send requests must be refused — protection is not removed');
});

test('Test 3b: a 429 body is machine-readable and does not read as a failure', async () => {
  const ip = '203.0.113.31';
  await hammer('/send-email', SEND_LIMIT_PER_MINUTE, { method: 'POST', ip });

  const res = await req('/send-email', { method: 'POST', ip });
  assert.equal(res.status, 429);

  const body = await res.json();
  assert.equal(body.code, 'RATE_LIMITED', 'frontend branches on code, not on prose');

  // `error` is populated as well as `message` specifically so the old frontend's
  // `data.error || "Send failed."` fallback cannot produce "Send failed."
  assert.ok(body.error, 'error must be present so the legacy fallback is never reached');
  assert.equal(body.error, body.message);
  assert.doesNotMatch(body.error, /send failed/i, 'a rate limit must not be described as a failed send');
  assert.match(body.error, /unaffected/i, 'message should tell the operator the campaign is fine');
});

// ── Bucket isolation, both directions ────────────────────────────────────────
test('send and monitoring buckets are independent of each other', async () => {
  const ip = '203.0.113.40';

  // Exhaust sending.
  await hammer('/send-email', SEND_LIMIT_PER_MINUTE + 5, { method: 'POST', ip });
  const blocked = await req('/send-email', { method: 'POST', ip });
  assert.equal(blocked.status, 429, 'send bucket should be exhausted');

  // Monitoring must be unaffected: an operator who over-submits must still be
  // able to see what is happening.
  const status = await req('/status', { ip });
  assert.equal(status.status, 200, 'monitoring must survive send-bucket exhaustion');
});

test('the global backstop still protects unclassified routes', async () => {
  const ip = '203.0.113.50';

  // 1000 outside production per config/env; exceed it to prove the backstop is
  // still wired up rather than skipped for everything.
  const codes = await hammer('/logs', 1005, { ip });
  assert.ok(codes.includes(429), '/logs must still be covered by the global limiter');
});

test('classified paths are skipped by the global limiter, so nothing is double-counted', async () => {
  const ip = '203.0.113.60';

  const before = await getSharedRedisClient().keys('rl:global:*');

  await hammer('/status', 30, { ip });
  await hammer('/send-email', 5, { method: 'POST', ip });

  const globalKeysForThisIp = (await getSharedRedisClient().keys('rl:global:*'))
    .filter((k) => k.includes(ip));

  assert.equal(
    globalKeysForThisIp.length,
    0,
    'dedicated paths must not consume the global bucket'
  );

  // And they are recorded in their own buckets instead.
  const sendKeys = (await getSharedRedisClient().keys('rl:send:*')).filter((k) => k.includes(ip));
  const monitorKeys = (await getSharedRedisClient().keys('rl:monitor:*')).filter((k) => k.includes(ip));

  assert.ok(sendKeys.length > 0, 'send requests must be counted in rl:send:');
  assert.ok(monitorKeys.length > 0, 'status requests must be counted in rl:monitor:');
  assert.ok(Array.isArray(before));
});

test('the skip list and the mounted limiters agree', () => {
  // Guards against adding a dedicated limiter in app.js without exempting the
  // path here, which would silently reintroduce double-counting.
  assert.deepEqual(
    [...DEDICATED_LIMITER_PATHS].sort(),
    ['/api/system-health', '/send-email', '/status']
  );
});
