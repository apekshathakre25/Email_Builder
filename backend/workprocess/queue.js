// Required before REDIS_URL is read below. Resolved from the backend directory
// rather than the working directory — see config/loadEnv.js.
require('../config/loadEnv');

const Queue = require('bull');
const { URL } = require('url');

console.log('🔍 Queue: Checking Redis configuration...');
console.log('Queue: Environment variables loaded:', Object.keys(process.env).filter(key => key.includes('REDIS')));

if (!process.env.REDIS_URL) {
  console.error('❌ REDIS_URL environment variable is required but not set!');
  throw new Error('REDIS_URL environment variable is required.');
}

const redisUrl = new URL(process.env.REDIS_URL);
const isSecure = redisUrl.protocol === 'rediss:';

/**
 * The database number from the URL path, or 0 when there isn't one.
 *
 * This used to be dropped. Because config/redis.js hands the whole REDIS_URL to
 * ioredis, which does honour the path, the two halves of the application disagreed
 * about which database they were on: set REDIS_URL=redis://host:6379/3 and the stop
 * markers, rate-limit buckets and per-campaign tallies would live in database 3 while
 * the jobs they describe lived in database 0. `isCampaignStopped` would then never see
 * a stop, and the test suite — which isolates itself onto database 15 — could not
 * isolate the queue at all.
 *
 * Invisible in production only because the deployed URL carries no path, which is
 * exactly what this resolves to when absent, so behaviour there is unchanged.
 */
const redisDb = (() => {
  const path = (redisUrl.pathname || '').replace(/^\//, '');
  if (path === '') return 0;

  const parsed = Number(path);
  if (!Number.isInteger(parsed) || parsed < 0) {
    console.warn(`⚠️  Queue: ignoring unusable Redis database "${path}" in REDIS_URL; using 0.`);
    return 0;
  }
  return parsed;
})();

const redisOptions = {
  host: redisUrl.hostname,
  port: Number(redisUrl.port),
  password: redisUrl.password,
  db: redisDb,
  tls: isSecure ? {} : undefined,

  retryStrategy: (times) => {
    const delay = Math.min(times * 50, 2000);
    return delay;
  },

  connectTimeout: 10000,

  keepAlive: 30000
};

const emailQueue = new Queue('emailQueue', {
  redis: redisOptions,

  // Safety net for any producer that adds a job without explicit opts. Bull
  // otherwise retains completed and failed jobs indefinitely, and each record
  // carries the full email payload including the HTML body.
  //
  // Note: routes/sendemails.js passes per-job opts, which take precedence over
  // these defaults — that call site is where send jobs get their retention.
  defaultJobOptions: {
    removeOnComplete: 1000,
    removeOnFail: 5000
  }
});

emailQueue.on('error', (err) => {
  console.error('❌ Bull Queue error:', err.message);
  console.error('Full queue error:', err);
});

emailQueue.on('ready', () => {
  console.log('✅ Bull Queue ready and connected to Redis');
});

module.exports = emailQueue;
