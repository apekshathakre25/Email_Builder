const env = require('./env');
const Redis = require('ioredis');

function createRedisClient() {
  if (!process.env.REDIS_URL) {
    console.error('❌ REDIS_URL environment variable is required but not set!');
    throw new Error('REDIS_URL environment variable is required.');
  }

  const isSecure = process.env.REDIS_URL.startsWith('rediss://');

  const client = new Redis(process.env.REDIS_URL, {

    tls: isSecure ? {} : undefined,


    retryStrategy(times) {
      if (times > 30) {
        console.error(`❌ Redis: gave up reconnecting after ${times} attempts`);
        return null;
      }
      const delay = Math.min(times * 50, 10000);
      console.warn(`⚠️  Redis: reconnect attempt ${times}, next try in ${delay}ms`);
      return delay;
    },

    reconnectOnError(err) {
      const targetErrors = ['READONLY', 'ECONNRESET', 'ETIMEDOUT'];
      return targetErrors.some(e => err.message.includes(e));
    },

    keepAlive: 30000,

    connectTimeout: 10000,

    commandTimeout: 30000,


    enableOfflineQueue: true,

    maxRetriesPerRequest: null,

    lazyConnect: false,
  });

  client.on('connect',      ()    => console.log('✅ Redis connected'));
  client.on('ready',        ()    => console.log('🚀 Redis ready'));
  client.on('reconnecting', (ms)  => console.warn(`⚠️  Redis reconnecting in ${ms}ms…`));
  client.on('close',        ()    => console.warn('⚠️  Redis connection closed'));
  client.on('end',          ()    => console.error('❌ Redis connection ended permanently'));
  client.on('error',        (err) => {

    console.error('❌ Redis error:', err.message);
  });

  return client;
}

/**
 * Process-wide shared connection, for callers that just need to run commands
 * (OTP store, rate limiter). Reuses one socket instead of opening a new
 * connection per module. Callers that need a dedicated connection — anything
 * issuing blocking commands or entering subscriber mode — should keep using
 * createRedisClient() directly.
 */
let sharedClient = null;

function getSharedRedisClient() {
  if (!sharedClient) {
    sharedClient = createRedisClient();
  }
  return sharedClient;
}

module.exports = createRedisClient;
module.exports.getSharedRedisClient = getSharedRedisClient;
