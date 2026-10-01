/**
 * Rate limiting.
 *
 * ── Why this file is shaped the way it is ────────────────────────────────────
 *
 * A single global bucket (300 req/min/IP) used to cover every route. That
 * conflated three unrelated things — monitoring reads, campaign submission, and
 * generic abuse protection — into one allowance, and it caused a production
 * outage:
 *
 *   /status polled every 1s + a browser extension reloading every 5s
 *     -> the shared 300/min bucket was exhausted by monitoring traffic
 *     -> POST /send-email got 429
 *     -> no batch was enqueued, so the workers had nothing to send
 *     -> sending genuinely stopped for ~55s until the window rolled over
 *
 * Production evidence from that incident: 1472 requests to /status against 7 to
 * /send-email, and 1009 total 429s (966 /status, 40 /api/system-health,
 * 3 /send-email). Three rejected sends were enough to stall the campaign,
 * because campaign progress depends on that POST succeeding.
 *
 * The fix is not a higher ceiling — it is separate buckets. Monitoring traffic
 * and campaign submission now draw from different allowances, so no amount of
 * polling can starve a send.
 *
 * ── Bucket layout ───────────────────────────────────────────────────────────
 *
 *   sendLimiter        POST /send-email                  60/min   own bucket
 *   monitoringLimiter  GET /status, /api/system-health   600/min  own bucket
 *   globalLimiter      everything else                   300/min  backstop
 *   otpRequestLimiter  POST /send-otp                     5/15min
 *   loginLimiter       POST /login                       10/15min
 *
 * globalLimiter skips the paths above precisely because they are already
 * limited by a dedicated bucket — every request is still counted somewhere, so
 * this creates no bypass.
 *
 * ── What this file deliberately does NOT do ──────────────────────────────────
 *
 * HTTP request rate is not email volume. One POST can enqueue an entire file,
 * because the batch size comes from the request (`limit`), so counting requests
 * says almost nothing about how much sending work was submitted. Volume control
 * belongs at the campaign level — recipients per user per window, checked
 * against the queue — not here. See the report's "remaining architectural
 * issues"; that control needs a product decision on the actual quota, so it is
 * not invented in this file.
 */

const rateLimit = require('express-rate-limit');
const { RedisStore } = require('rate-limit-redis');
const { getSharedRedisClient } = require('../config/redis');
const env = require('./../config/env');

function redisStore(prefix) {
  const client = getSharedRedisClient();

  return new RedisStore({
    prefix,

    sendCommand: (...args) => client.call(...args)
  });
}

/**
 * 429 body.
 *
 * `error` is included alongside `message` on purpose. The browser reads
 * `data.error` and falls back to the string "Send failed." when it is absent,
 * which is exactly how a rate-limited request came to be reported to operators
 * as a failed campaign. Populating both fields means even a cached copy of the
 * old frontend shows something truthful.
 *
 * `code` is what new frontend code branches on, so it never has to pattern-match
 * on prose.
 */
const jsonHandler = (message) => (req, res) => {
  const retryAfterSeconds = Number(res.getHeader('Retry-After')) || undefined;

  res.status(429).json({
    success: false,
    code: 'RATE_LIMITED',
    error: message,
    message,
    retryAfterSeconds
  });
};

const otpRequestLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  store: redisStore('rl:otp:'),
  keyGenerator: (req) => {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    return email || req.ip;
  },
  handler: jsonHandler('Too many OTP requests. Please wait a few minutes and try again.')
});

/**
 * Login verification attempts. The per-code attempt cap in the OTP store stops
 * guessing against a single code; this stops cycling through fresh codes.
 */
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  store: redisStore('rl:login:'),
  keyGenerator: (req) => {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    return email || req.ip;
  },
  handler: jsonHandler('Too many login attempts. Please wait a few minutes and try again.')
});

/**
 * Campaign submission. Its own bucket, so monitoring traffic can never consume
 * the allowance a send depends on — that is the entire point of this limiter.
 *
 * 60/min against an observed need of ~12/min (the browser posts one batch about
 * every 5s), so roughly 5x headroom for a fast operator or a second tab, while
 * still stopping a runaway client from enqueueing without bound.
 *
 * Keyed by IP rather than authenticated user because this runs before
 * authenticateToken. Mounting it after auth would give a truer per-account
 * limit, but would let unauthenticated floods skip the bucket entirely; the
 * cheap, un-bypassable check is the better trade here.
 */
const SEND_LIMIT_PER_MINUTE = 60;

const sendLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: SEND_LIMIT_PER_MINUTE,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  store: redisStore('rl:send:'),
  handler: jsonHandler(
    'Too many send requests in a short period. Your campaign is unaffected — please wait a moment before submitting another batch.'
  )
});

/**
 * Read-only monitoring: /status and /api/system-health.
 *
 * Generous, because these are the application's own polling and the cost per
 * call is small (/status is two indexed Mongo reads plus two O(1) Redis reads —
 * a GET for the resume position and an HMGET for the live tally). At the
 * frontend's 1.5s polling interval one tab uses ~40/min, so 600/min still
 * tolerates a dozen open tabs before anything is refused.
 *
 * The important property is not the number: it is that exhausting this bucket
 * can only ever degrade monitoring. It cannot stop a campaign.
 */
const MONITORING_LIMIT_PER_MINUTE = 600;

const monitoringLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: MONITORING_LIMIT_PER_MINUTE,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  store: redisStore('rl:monitor:'),
  handler: jsonHandler('Status is being polled too frequently. Sending is unaffected.')
});

/**
 * Paths that carry their own limiter and must therefore not also draw down the
 * global bucket. Kept next to globalLimiter so the skip list and the dedicated
 * limiters cannot drift apart unnoticed.
 */
const DEDICATED_LIMITER_PATHS = new Set([
  '/send-email',
  '/status',
  '/api/system-health'
]);

/**
 * Backstop for everything else: file listings, log queries, config reads, and
 * any route added later without a considered limit of its own.
 *
 * Still 300/min/IP. That figure was never the problem — sharing it with
 * monitoring was.
 */
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: env.isProduction ? 300 : 1000,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  store: redisStore('rl:global:'),
  skip: (req) => DEDICATED_LIMITER_PATHS.has(req.path),
  handler: jsonHandler('Too many requests. Please slow down.')
});

module.exports = {
  otpRequestLimiter,
  loginLimiter,
  globalLimiter,
  sendLimiter,
  monitoringLimiter,
  DEDICATED_LIMITER_PATHS,
  SEND_LIMIT_PER_MINUTE,
  MONITORING_LIMIT_PER_MINUTE
};
