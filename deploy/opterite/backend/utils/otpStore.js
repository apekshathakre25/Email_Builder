const { getSharedRedisClient } = require('../config/redis');

const TTL_SECONDS = 5 * 60;
const MAX_ATTEMPTS = 5;
const KEY_PREFIX = 'otp:login:';

function keyFor(email) {
  return `${KEY_PREFIX}${String(email).toLowerCase().trim()}`;
}

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

async function get(email) {
  const redis = getSharedRedisClient();
  const data = await redis.hgetall(keyFor(email));

  if (!data || !data.otp) {
    return null;
  }

  return { otp: data.otp, attempts: Number(data.attempts) || 0 };
}

async function recordFailedAttempt(email) {
  const redis = getSharedRedisClient();
  return redis.hincrby(keyFor(email), 'attempts', 1);
}

async function remove(email) {
  const redis = getSharedRedisClient();
  await redis.del(keyFor(email));
}

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
