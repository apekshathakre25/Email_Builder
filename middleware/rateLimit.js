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

const jsonHandler = (message) => (req, res) => {
  res.status(429).json({ success: false, message });
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
 * Blanket limiter for everything else. Generous enough not to interfere with
 * the dashboard, which polls /api/system-health every 10s.
 */
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: env.isProduction ? 300 : 1000,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  store: redisStore('rl:global:'),
  handler: jsonHandler('Too many requests. Please slow down.')
});

module.exports = { otpRequestLimiter, loginLimiter, globalLimiter };
