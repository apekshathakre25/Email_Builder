/**
 * Tests for the configurable email send rate limit (utils/emailRateLimiter.js).
 *
 * WHAT IS ACTUALLY BEING PINNED DOWN
 * ----------------------------------
 * The requirement is a *rate*, not a batch cadence: "at most `limit` sends in any
 * `interval` window", with work flowing continuously in between. The two failure
 * modes worth guarding against are therefore opposite in shape:
 *
 *   too many  — the window admits more than `limit`, which is what a per-process
 *               counter would do across the 14 worker processes PM2 starts.
 *   too few   — the limiter behaves like "send a batch, sleep, send a batch",
 *               idling through capacity it was supposed to use.
 *
 * Every drain test asserts both: an upper bound on any window, and that the whole
 * recipient list completed in about the number of windows the arithmetic implies.
 *
 * WHY THE ASSERTIONS USE REDIS' CLOCK
 * -----------------------------------
 * Timestamps come from the `atMs` the limiter reports, which is the score the
 * entry was stored under and the value the sliding window is computed against.
 * Recording Date.now() around the call instead would add a few ms of jitter on
 * each side of a boundary and make a correct limiter look like it admitted an
 * extra send.
 *
 * These tests wait in real time (~20s total). The interval is the unit under
 * test, so compressing it would test something else.
 */

// Required first: it moves Redis onto an isolated database before any module
// that builds a client at require time can be loaded.
const {
  clearTestRedisKeys,
  testSessionId,
  getSharedRedisClient
} = require('./helpers/testDb');

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createEmailRateLimiter,
  parseRateLimitConfig,
  normalizeJobRateLimit,
  RateLimitWaitAbortedError,
  bucketKey,
  LIMIT_MAX,
  INTERVAL_SECONDS_MAX
} = require('../utils/emailRateLimiter');

const createRedisClient = require('../config/redis');

/**
 * Largest number of grants falling inside any window-length span.
 *
 * Checks every grant as a window start rather than only the fixed
 * floor(t / interval) boundaries, because the limiter promises the bound holds at
 * every window position — a fixed-window implementation would pass the boundary
 * check while allowing a double burst straddling one.
 */
function maxInAnyWindow(timestamps, windowMs) {
  const sorted = [...timestamps].sort((a, b) => a - b);
  let max = 0;

  for (let i = 0; i < sorted.length; i++) {
    let count = 0;
    for (let j = i; j < sorted.length; j++) {
      if (sorted[j] - sorted[i] >= windowMs) break;
      count++;
    }
    if (count > max) max = count;
  }

  return max;
}

/**
 * Grants per consecutive window, counting windows forward from the first grant.
 *
 * This is the "0-5s, 5-10s, 10-15s" view the requirement is written in, and it is
 * well defined for this limiter: a grant can only be admitted once an entry one
 * full window older has aged out, so no grant can land in an earlier bucket than
 * the one the arithmetic puts it in.
 */
function windowHistogram(timestamps, windowMs) {
  const sorted = [...timestamps].sort((a, b) => a - b);
  const origin = sorted[0];
  const buckets = [];

  for (const t of sorted) {
    const index = Math.floor((t - origin) / windowMs);
    while (buckets.length <= index) buckets.push(0);
    buckets[index]++;
  }

  return buckets;
}

/**
 * Drives `count` sends through the limiter the way the worker does: wait for a
 * slot, then "send". Returns the Redis-assigned grant timestamps.
 */
async function drain(limiter, config, count) {
  const grants = [];

  for (let i = 0; i < count; i++) {
    const outcome = await limiter.waitForSlot(config);
    grants.push(outcome.atMs);
  }

  return grants;
}

function config(scope, limit, intervalSeconds) {
  return { scope, limit, intervalMs: Math.ceil(intervalSeconds * 1000) };
}

test.beforeEach(async () => {
  await clearTestRedisKeys();
});

test.after(async () => {
  await clearTestRedisKeys();
  await getSharedRedisClient().quit();
});

/**
 * TEST 1 — the headline acceptance criterion.
 * Limit 35, interval 5s, 100 recipients.
 */
test('limit 35 / interval 5s never exceeds 35 sends in any 5s window across 100 recipients', async () => {
  const limiter = createEmailRateLimiter(getSharedRedisClient());
  const cfg = config(testSessionId('rate-35-5'), 35, 5);

  const startedAt = Date.now();
  const grants = await drain(limiter, cfg, 100);
  const elapsed = Date.now() - startedAt;

  assert.equal(grants.length, 100, 'every recipient must eventually be sent');

  assert.ok(
    maxInAnyWindow(grants, cfg.intervalMs) <= 35,
    `no 5s window may hold more than 35 sends, saw ${maxInAnyWindow(grants, cfg.intervalMs)}`
  );

  // 100 at 35 per window needs three windows: 35 + 35 + 30. The third only has
  // 30 recipients left, so it must not wait for a 35th — the run ends as soon as
  // the list does.
  assert.ok(
    elapsed >= 9000,
    `100 sends at 35/5s cannot finish before the third window opens (took ${elapsed}ms)`
  );
  assert.ok(
    elapsed < 14000,
    `100 sends at 35/5s must finish in about three windows, not four (took ${elapsed}ms)`
  );

  // The distribution the requirement spells out: 35, then 35, then the 30 that
  // remain. Windows are counted forward from the first grant, which is the frame
  // the requirement describes ("0-5s, 5-10s, 10-15s").
  //
  // Bucketing forward is also the only stable way to check this. A window
  // measured backwards from the last grant would straddle two bursts and count
  // up to a full `limit`, because capacity here frees in a batch: the opening 35
  // grants land within milliseconds of each other, so they also age out of the
  // window within milliseconds of each other.
  assert.deepEqual(
    windowHistogram(grants, cfg.intervalMs),
    [35, 35, 30],
    'expected three windows carrying 35, 35 and 30 — the last must not pad to 35'
  );
});

/**
 * TEST 2 — a different limit/interval pair, to show the values are configuration
 * rather than constants baked around the 35/5 case.
 */
test('limit 10 / interval 2s never exceeds 10 sends in any 2s window across 25 recipients', async () => {
  const limiter = createEmailRateLimiter(getSharedRedisClient());
  const cfg = config(testSessionId('rate-10-2'), 10, 2);

  const startedAt = Date.now();
  const grants = await drain(limiter, cfg, 25);
  const elapsed = Date.now() - startedAt;

  assert.equal(grants.length, 25);
  assert.ok(
    maxInAnyWindow(grants, cfg.intervalMs) <= 10,
    `no 2s window may hold more than 10 sends, saw ${maxInAnyWindow(grants, cfg.intervalMs)}`
  );

  assert.deepEqual(
    windowHistogram(grants, cfg.intervalMs),
    [10, 10, 5],
    'expected 10, 10 then the 5 that remain'
  );

  assert.ok(elapsed >= 3500, `expected to span three 2s windows (took ${elapsed}ms)`);
  assert.ok(elapsed < 7000, `expected not to spill into a fourth window (took ${elapsed}ms)`);
});

/** TEST 3 — the degenerate case: one email per second. */
test('limit 1 / interval 1s sends at most one email per second', async () => {
  const limiter = createEmailRateLimiter(getSharedRedisClient());
  const cfg = config(testSessionId('rate-1-1'), 1, 1);

  const grants = await drain(limiter, cfg, 4);

  assert.equal(grants.length, 4);
  assert.equal(maxInAnyWindow(grants, cfg.intervalMs), 1, 'exactly one send per second');

  for (let i = 1; i < grants.length; i++) {
    assert.ok(
      grants[i] - grants[i - 1] >= 1000,
      `consecutive sends must be at least 1s apart, got ${grants[i] - grants[i - 1]}ms`
    );
  }
});

/**
 * TEST 4 — the concurrency requirement, and the reason the bucket is in Redis.
 *
 * Three limiters on three separate connections stand in for three worker
 * processes. If the counter were per-process this admits 3 × 10 = 30 in the first
 * second instead of 10.
 */
test('a shared limit is not multiplied by concurrent workers', async () => {
  const clients = [createRedisClient(), createRedisClient(), createRedisClient()];

  try {
    const limiters = clients.map((client) => createEmailRateLimiter(client));
    const cfg = config(testSessionId('rate-concurrent'), 10, 1);

    // 10 sends per worker, all interleaved, all against the same campaign.
    const perWorker = 10;
    const results = await Promise.all(
      limiters.map((limiter) => drain(limiter, cfg, perWorker))
    );

    const grants = results.flat();
    assert.equal(grants.length, perWorker * limiters.length, 'no send may be dropped');

    assert.ok(
      maxInAnyWindow(grants, cfg.intervalMs) <= 10,
      `three workers must share one 10/1s allowance, saw ` +
      `${maxInAnyWindow(grants, cfg.intervalMs)} in a single window`
    );
  } finally {
    await Promise.all(clients.map((client) => client.quit()));
  }
});

/**
 * TEST 5 — retries are sends.
 *
 * The limiter sits immediately before transporter.sendMail, so a redelivered job
 * re-acquires like any other send. A retry that skipped the limiter would be a
 * hole in the guarantee exactly when a campaign is already misbehaving.
 */
test('a retried send consumes rate-limit capacity instead of bypassing it', async () => {
  const limiter = createEmailRateLimiter(getSharedRedisClient());
  const cfg = config(testSessionId('rate-retry'), 5, 2);

  // First attempt for five recipients fills the window.
  const firstAttempts = await drain(limiter, cfg, 5);
  assert.equal(firstAttempts.length, 5);

  // One of them "failed" and is retried. Capacity is gone, so the retry is
  // refused right now rather than waved through.
  const immediate = await limiter.acquire(cfg);
  assert.equal(immediate.allowed, false, 'a retry must not find free capacity in a full window');
  assert.ok(immediate.retryAfterMs > 0, 'the retry must be told when capacity returns');

  const retry = await limiter.waitForSlot(cfg);
  assert.ok(retry.waitedMs > 0, 'the retry waited for the next window');

  const all = [...firstAttempts, retry.atMs];
  assert.ok(
    maxInAnyWindow(all, cfg.intervalMs) <= 5,
    'first attempts plus the retry must still respect 5 per 2s'
  );
});

/**
 * TEST 6 — cancellation, which for this worker means SIGTERM.
 *
 * A job parked on the limiter has to abandon the send when the process is
 * shutting down. Without this, emailQueue.close() would block on parked jobs
 * until PM2's kill_timeout, and work already queued would keep draining after the
 * operator asked the worker to stop.
 */
test('a cancelled or shutting-down worker stops waiting and sends nothing further', async () => {
  const limiter = createEmailRateLimiter(getSharedRedisClient());
  const cfg = config(testSessionId('rate-cancel'), 3, 30);

  const granted = await drain(limiter, cfg, 3);
  assert.equal(granted.length, 3);

  let cancelled = false;
  const waiting = limiter.waitForSlot(cfg, {
    shouldAbort: () => (cancelled ? 'worker is shutting down' : false)
  });

  // Let the wait loop park, then cancel.
  await new Promise((resolve) => setTimeout(resolve, 400));
  cancelled = true;

  await assert.rejects(
    waiting,
    (err) => {
      assert.ok(err instanceof RateLimitWaitAbortedError);
      assert.equal(err.reason, 'worker is shutting down');
      return true;
    },
    'the parked send must abort rather than wait out a 30s window'
  );

  // Cancelling released no capacity and consumed none: still exactly the three
  // original grants in the bucket.
  assert.equal(
    await getSharedRedisClient().zcard(bucketKey(cfg.scope)),
    3,
    'an abandoned wait must neither consume nor free a slot'
  );
});

/**
 * TEST 7 — backward compatibility.
 *
 * Before this feature `limit` was a per-submission batch size and nothing was
 * paced. A campaign, saved draft, or already-queued job with no interval has to
 * keep behaving that way.
 */
test('configurations without an interval are unthrottled, as before', async () => {
  // Saved draft with only a limit: valid, no rate limiting, limit still parsed so
  // the route can go on using it as a batch size.
  const legacy = parseRateLimitConfig({ limit: '35' });
  assert.equal(legacy.ok, true);
  assert.equal(legacy.config, null, 'no interval means no rate limiting');
  assert.equal(legacy.parsedLimit, 35, 'limit is still available as a batch size');

  // A completely empty form is also valid and unthrottled.
  const empty = parseRateLimitConfig({});
  assert.equal(empty.ok, true);
  assert.equal(empty.config, null);
  assert.equal(empty.parsedLimit, null);

  // Jobs already sitting in Redis from before the feature carry no rateLimit
  // block, and the worker must read that as "send normally".
  assert.equal(normalizeJobRateLimit(undefined), null);
  assert.equal(normalizeJobRateLimit(null), null);

  // A malformed block degrades to unthrottled rather than failing the recipient,
  // and says so.
  let warned = false;
  assert.equal(
    normalizeJobRateLimit(
      { limit: 0, intervalMs: 5000, scope: 'x' },
      { onInvalid: () => { warned = true; } }
    ),
    null
  );
  assert.equal(warned, true, 'an unusable rateLimit block is reported, not silently ignored');
});

/** Both values together produce a usable rate. */
test('a valid limit and interval produce a millisecond window', async () => {
  const parsed = parseRateLimitConfig({ limit: '35', intervalSeconds: '5' });

  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.config, { limit: 35, intervalSeconds: 5, intervalMs: 5000 });

  // Fractional seconds are allowed and round up, so a window can never be 0ms.
  assert.equal(parseRateLimitConfig({ limit: '2', intervalSeconds: '0.25' }).config.intervalMs, 250);
});

/** Server-side validation, which is what actually decides. */
test('invalid limits and intervals are rejected server-side', async () => {
  const rejected = [
    [{ limit: '0', intervalSeconds: '5' }, 'zero limit'],
    [{ limit: '-5', intervalSeconds: '5' }, 'negative limit'],
    [{ limit: '3.5', intervalSeconds: '5' }, 'fractional limit'],
    [{ limit: 'abc', intervalSeconds: '5' }, 'non-numeric limit'],
    [{ limit: '35abc', intervalSeconds: '5' }, 'limit with trailing text'],
    [{ limit: String(LIMIT_MAX + 1), intervalSeconds: '5' }, 'limit above the ceiling'],
    [{ limit: '35', intervalSeconds: '0' }, 'zero interval'],
    [{ limit: '35', intervalSeconds: '-5' }, 'negative interval'],
    [{ limit: '35', intervalSeconds: 'soon' }, 'non-numeric interval'],
    [{ limit: '35', intervalSeconds: String(INTERVAL_SECONDS_MAX + 1) }, 'interval above the ceiling'],
    [{ intervalSeconds: '5' }, 'interval with no limit']
  ];

  for (const [input, label] of rejected) {
    const result = parseRateLimitConfig(input);
    assert.equal(result.ok, false, `${label} must be rejected`);
    assert.equal(typeof result.error, 'string');
    assert.ok(result.error.length > 0, `${label} must come with an explanation`);
  }
});

/** The bucket cleans itself up so an abandoned campaign leaves no keys behind. */
test('a rate-limit bucket expires on its own', async () => {
  const limiter = createEmailRateLimiter(getSharedRedisClient());
  const cfg = config(testSessionId('rate-ttl'), 5, 2);

  await limiter.waitForSlot(cfg);

  const ttl = await getSharedRedisClient().pttl(bucketKey(cfg.scope));
  assert.ok(ttl > 0, 'the bucket must carry an expiry');
  assert.ok(ttl <= cfg.intervalMs + 1000, 'the expiry must be about one window of grace');
});
