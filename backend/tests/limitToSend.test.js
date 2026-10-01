/**
 * "Limit to Send" — the cap on ONE Send Email action.
 *
 * TWO CONTROLS, TWO JOBS. `Limit` + `Interval` are a *rate*: 35 emails every 5 seconds,
 * enforced in the workers by utils/emailRateLimiter. `Limit to Send` is a *batch size*:
 * how many entries this click releases at all. They compose — "35 per 5s, but only
 * 30,000 this time" — and neither is derived from the other.
 *
 * WHY IT WAS NEEDED. Before this, the two were conflated by accident. With no interval,
 * `limit` doubled as the per-click batch size. With an interval, `limit` became the rate
 * and stopped bounding the submission at all: every remaining recipient was enqueued and
 * the limiter paced them. So a paced campaign had no way to release only part of itself.
 *
 * HOW PROGRESS IS TRACKED. `sentIndex:<id>` is the watermark, counting entries released
 * across every action. Each click reserves the next range from it, so click two continues
 * where click one stopped. Nothing is keyed on the email address — a recipient list holds
 * one entry per send, and duplicates are separate sends with their own `sendId`.
 *
 * These tests drive the reservation and validation directly. tests/limitToSendRoutes
 * covers POST /send-email end to end.
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

const sendEmails = require('../routes/sendemails');
const {
  parseLimitToSend,
  reserveSendWindow,
  LIMIT_TO_SEND_MIN,
  LIMIT_TO_SEND_MAX
} = sendEmails;

let redis;

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
 * Validation.
 * ================================================================== */

test('an empty Limit to Send means no cap, preserving the previous behaviour', () => {
  for (const raw of ['', '   ', null, undefined]) {
    const parsed = parseLimitToSend(raw);
    assert.equal(parsed.ok, true, `"${raw}" must be accepted`);
    assert.equal(parsed.value, null, 'null is the signal for "no per-action limit"');
  }
});

test('a positive integer is accepted', () => {
  assert.deepEqual(parseLimitToSend('30000'), { ok: true, value: 30000 });
  assert.deepEqual(parseLimitToSend(30000), { ok: true, value: 30000 });
  assert.deepEqual(parseLimitToSend(' 1 '), { ok: true, value: LIMIT_TO_SEND_MIN });
});

test('zero and negatives are rejected', () => {
  assert.equal(parseLimitToSend('0').ok, false);
  assert.match(parseLimitToSend('0').error, /at least 1/);
  assert.equal(parseLimitToSend('-5').ok, false);
  assert.equal(parseLimitToSend(-1).ok, false);
});

test('non-numeric and fractional values are rejected', () => {
  for (const raw of ['abc', '30000abc', '1e', '3.5', '--1', '1,000']) {
    assert.equal(parseLimitToSend(raw).ok, false, `"${raw}" must be rejected`);
  }

  // Number(), not parseInt(): parseInt('30000abc') would have silently accepted 30000.
  assert.match(parseLimitToSend('30000abc').error, /whole number/);
});

test('an absurd value is rejected as a typo', () => {
  assert.equal(parseLimitToSend(String(LIMIT_TO_SEND_MAX)).ok, true, 'the ceiling itself is fine');
  assert.equal(parseLimitToSend(String(LIMIT_TO_SEND_MAX + 1)).ok, false);
});

test('the ceiling is wider than the rate limit, because it counts recipients', () => {
  // `limit` maxes at 1,000,000 because a rate beyond that is meaningless. A campaign can
  // legitimately have more recipients than that, so this bound is only a typo guard.
  assert.ok(LIMIT_TO_SEND_MAX > 1000000);
  assert.equal(parseLimitToSend('2000000').ok, true);
});

/* ================================================================== *
 * The reservation: 70k -> 30k -> 30k -> 10k.
 * ================================================================== */

test('three clicks walk a 70k campaign in 30k/30k/10k without overlap or gaps', async () => {
  const id = testSessionId('walk-70k');
  const TOTAL = 70000;
  const CAP = 30000;

  const first = await reserveSendWindow(id, { total: TOTAL, want: CAP });
  assert.deepEqual(first, { start: 0, granted: 30000 }, 'entries 0..29,999');

  const second = await reserveSendWindow(id, { total: TOTAL, want: CAP });
  assert.deepEqual(second, { start: 30000, granted: 30000 }, 'entries 30,000..59,999');

  const third = await reserveSendWindow(id, { total: TOTAL, want: CAP });
  assert.deepEqual(third, { start: 60000, granted: 10000 },
    'only the remaining 10,000, not a full 30,000');

  // Every entry exactly once: contiguous, no overlap, no gap.
  assert.equal(first.start + first.granted, second.start, 'no gap and no overlap');
  assert.equal(second.start + second.granted, third.start);
  assert.equal(first.granted + second.granted + third.granted, TOTAL, 'all 70,000 released');
});

test('a fourth click has nothing left to take', async () => {
  const id = testSessionId('exhausted');
  await reserveSendWindow(id, { total: 100, want: 100 });

  const again = await reserveSendWindow(id, { total: 100, want: 50 });
  assert.equal(again.granted, 0, 'nothing granted');
  assert.equal(again.start, 100, 'and the watermark has not moved past the total');
});

test('a cap larger than the remaining count releases only the remainder', async () => {
  const id = testSessionId('cap-exceeds');
  await reserveSendWindow(id, { total: 100, want: 90 });

  const rest = await reserveSendWindow(id, { total: 100, want: 30000 });
  assert.deepEqual(rest, { start: 90, granted: 10 }, 'only the 10 that are left');
});

test('the remaining count can never go negative', async () => {
  const id = testSessionId('no-negative');

  for (let i = 0; i < 5; i++) {
    const r = await reserveSendWindow(id, { total: 50, want: 40 });
    assert.ok(r.granted >= 0, 'granted is never negative');
    assert.ok(r.start + r.granted <= 50, 'and never reserves past the total');
  }

  const watermark = Number(await redis.get(`sentIndex:${id}`));
  assert.equal(watermark, 50, 'the watermark settles exactly at the total');
});

test('no cap reserves everything remaining in one action', async () => {
  const id = testSessionId('no-cap');

  // This is what an unlimited action asks for: the whole remaining list.
  const all = await reserveSendWindow(id, { total: 70000, want: 70000 });
  assert.deepEqual(all, { start: 0, granted: 70000 });
});

test('a cap of 1 walks the list one entry at a time', async () => {
  const id = testSessionId('one-at-a-time');
  const seen = [];

  for (let i = 0; i < 4; i++) {
    const r = await reserveSendWindow(id, { total: 4, want: 1 });
    seen.push(r.start);
    assert.equal(r.granted, 1);
  }

  assert.deepEqual(seen, [0, 1, 2, 3], 'each click takes exactly the next entry');
});

/* ================================================================== *
 * Concurrency: a double click must not queue the same entries twice.
 * ================================================================== */

test('two simultaneous clicks reserve disjoint ranges', async () => {
  const id = testSessionId('double-click');

  // The defect this replaced: read sentIndex, slice, enqueue, then INCRBY. The read came
  // first, so both requests sliced from 0 and both enqueued the same 30,000 recipients.
  const [a, b] = await Promise.all([
    reserveSendWindow(id, { total: 70000, want: 30000 }),
    reserveSendWindow(id, { total: 70000, want: 30000 })
  ]);

  const ranges = [a, b].sort((x, y) => x.start - y.start);

  assert.equal(ranges[0].start, 0);
  assert.equal(ranges[1].start, 30000, 'the second click starts where the first ended');
  assert.equal(ranges[0].granted + ranges[1].granted, 60000, 'together they take 60,000');
  assert.notEqual(a.start, b.start, 'and never the same entries');
});

test('many concurrent clicks partition the list exactly once', async () => {
  const id = testSessionId('concurrent-many');
  const TOTAL = 1000;
  const WANT = 100;

  const results = await Promise.all(
    Array.from({ length: 15 }, () => reserveSendWindow(id, { total: TOTAL, want: WANT }))
  );

  // Every reserved index, across every caller.
  const claimed = [];
  for (const r of results) {
    for (let i = r.start; i < r.start + r.granted; i++) claimed.push(i);
  }

  assert.equal(claimed.length, TOTAL, 'exactly the whole list was claimed');
  assert.equal(new Set(claimed).size, TOTAL, 'no index was claimed twice');
  assert.deepEqual(
    [...claimed].sort((x, y) => x - y),
    Array.from({ length: TOTAL }, (_, i) => i),
    'and none was skipped'
  );
});

test('concurrent clicks near the end of the list cannot over-reserve', async () => {
  const id = testSessionId('concurrent-tail');
  await reserveSendWindow(id, { total: 100, want: 95 });

  const results = await Promise.all([
    reserveSendWindow(id, { total: 100, want: 30 }),
    reserveSendWindow(id, { total: 100, want: 30 }),
    reserveSendWindow(id, { total: 100, want: 30 })
  ]);

  const granted = results.reduce((n, r) => n + r.granted, 0);
  assert.equal(granted, 5, 'only the 5 remaining entries are handed out in total');
  assert.equal(Number(await redis.get(`sentIndex:${id}`)), 100, 'watermark stops at the total');
});

/* ================================================================== *
 * The watermark is the server's record, and it survives.
 * ================================================================== */

test('the watermark carries a TTL so a live campaign cannot lose its position', async () => {
  const id = testSessionId('ttl');
  await reserveSendWindow(id, { total: 100, want: 10 });

  const ttl = await redis.ttl(`sentIndex:${id}`);
  assert.ok(ttl > 0, 'the resume position expires rather than leaking');
});

test('reserving nothing does not move the watermark', async () => {
  const id = testSessionId('zero-want');
  await reserveSendWindow(id, { total: 100, want: 10 });

  const before = await redis.get(`sentIndex:${id}`);
  const r = await reserveSendWindow(id, { total: 100, want: 0 });

  assert.equal(r.granted, 0);
  assert.equal(await redis.get(`sentIndex:${id}`), before, 'unchanged');
});

test('a campaign with no recipients reserves nothing', async () => {
  const id = testSessionId('empty');
  const r = await reserveSendWindow(id, { total: 0, want: 30000 });

  assert.deepEqual(r, { start: 0, granted: 0 });
});
