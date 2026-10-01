/**
 * Test database + Redis helpers.
 *
 * MongoDB runs in-memory rather than against Atlas, so the suite is not gated on
 * network reachability or an IP allowlist entry, and can never touch real data.
 *
 * Redis is the real local server, because the behaviour under test is TTL and
 * SCAN semantics that a stub would not reproduce faithfully. Every key the suite
 * writes is namespaced under a session id prefixed `testsuite-`, and dropped in
 * teardown.
 */

/**
 * Redis isolation, applied before anything can open a connection.
 *
 * Some of the behaviour under test is keyspace-wide by nature:
 * dropAllEmailLogKeys deletes every `emaillog:*` key, and
 * adoptPersistentSessionKeys walks every session key it can find. Pointed at the
 * default database those operate on real application keys, so the suite is moved
 * onto a dedicated logical database instead.
 *
 * This must run at require time and this module must be required first in every
 * test file, because config/redis reads REDIS_URL when a client is constructed.
 */
const TEST_REDIS_DB = 15;

// This module loads before config/env, which is normally what pulls .env into the
// environment, so it has to do that itself before reading REDIS_URL. Resolved from
// the backend directory rather than the working directory — see config/loadEnv.js.
require('../../config/loadEnv');

function isolateRedisDatabase() {
  const raw = process.env.REDIS_URL;
  if (!raw) throw new Error('REDIS_URL is required to run the test suite.');

  const url = new URL(raw);
  url.pathname = `/${TEST_REDIS_DB}`;
  const isolated = url.toString();

  if (!new RegExp(`/${TEST_REDIS_DB}$`).test(isolated)) {
    throw new Error(`Refusing to run: could not isolate Redis onto database ${TEST_REDIS_DB}.`);
  }

  process.env.REDIS_URL = isolated;
  return isolated;
}

isolateRedisDatabase();

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { getSharedRedisClient } = require('../../config/redis');

const SESSION_PREFIX = 'testsuite-';

let memoryServer = null;

async function startTestDb() {
  memoryServer = await MongoMemoryServer.create();
  await mongoose.connect(memoryServer.getUri('opterite-test'));
  return mongoose.connection;
}

async function stopTestDb() {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.connection.close();
  }
  if (memoryServer) {
    await memoryServer.stop();
    memoryServer = null;
  }
}

async function clearCollections() {
  const collections = await mongoose.connection.db.listCollections().toArray();
  for (const { name } of collections) {
    await mongoose.connection.db.collection(name).deleteMany({});
  }
}

/** A session id guaranteed not to collide with real application keys. */
function testSessionId(label) {
  return `${SESSION_PREFIX}${label}`;
}

/**
 * Empties the isolated test database.
 *
 * Safe to flush wholesale because isolateRedisDatabase() has already pointed the
 * connection at a database the application never selects — the app connects
 * without a database in its URL, which is database 0. Verified before flushing
 * rather than trusted.
 */
async function clearTestRedisKeys() {
  const redis = getSharedRedisClient();

  const [, currentDb] = await redis.client('INFO').then((info) => {
    const match = /\bdb=(\d+)/.exec(info);
    return [info, match ? Number(match[1]) : null];
  });

  if (currentDb !== TEST_REDIS_DB) {
    throw new Error(
      `Refusing to flush: connected to Redis database ${currentDb}, expected ${TEST_REDIS_DB}.`
    );
  }

  await redis.flushdb();
}

module.exports = {
  SESSION_PREFIX,
  TEST_REDIS_DB,
  startTestDb,
  stopTestDb,
  clearCollections,
  clearTestRedisKeys,
  testSessionId,
  getSharedRedisClient
};
