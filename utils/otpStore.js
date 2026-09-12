/**
 * Redis-backed store for login OTPs.
 *
 * Previously an in-process Map, which had two problems in production:
 *   1. Under PM2 cluster mode the OTP was issued by one worker and verified by
 *      another, so most logins failed with "OTP not found".
 *   2. Entries for codes that were never used were never reclaimed.
 *
 * Redis fixes both: state is shared across workers, and the key TTL expires
 * codes automatically. Absence of the key *is* expiry, so there is no separate
 * timestamp to compare against.
 */

const { getSharedRedisClient } = require('../config/redis');

const TTL_SECONDS = 5 * 60;
const MAX_ATTEMPTS = 5;
const KEY_PREFIX = 'otp:login:';

function keyFor(email) {
  return `${KEY_PREFIX}${String(email).toLowerCase().trim()}`;
}

/**
 * Stores a freshly generated code, replacing any previous one for that address
 * and resetting the attempt counter.
 */
async function set(email, otp) {
  const redis = getSharedRedisClient();
  const key = keyFor(email);

  await redis
    .multi()
    .del(key)
    .hset(key, { otp: String(otp), attempts: '0' })
    .expire(key, TTL_SECONDS)
    .exec();
}

/** Returns { otp, attempts } or null when absent/expired. */
async function get(email) {
  const redis = getSharedRedisClient();
  const data = await redis.hgetall(keyFor(email));

  if (!data || !data.otp) {
    return null;
  }

  return { otp: data.otp, attempts: Number(data.attempts) || 0 };
}

/**
 * Records a failed verification and returns the new attempt count.
 * Preserves the original TTL so a wrong guess can't extend the code's life.
 */
async function recordFailedAttempt(email) {
  const redis = getSharedRedisClient();
  return redis.hincrby(keyFor(email), 'attempts', 1);
}

async function remove(email) {
  const redis = getSharedRedisClient();
  await redis.del(keyFor(email));
}

/** Seconds remaining before the code expires, or null if there is no code. */
async function ttl(email) {
  const redis = getSharedRedisClient();
  const remaining = await redis.ttl(keyFor(email));
  return remaining >= 0 ? remaining : null;
}

module.exports = {
  set,
  get,
  recordFailedAttempt,
  remove,
  ttl,
  TTL_SECONDS,
  MAX_ATTEMPTS
};
