/**
 * Redis session-key lifecycle.
 *
 * Covers the orphan problem these keys had: no expiry at all, so any key whose
 * owning MongoDB row disappeared outside the retention sweep stayed forever.
 *
 * The important negative case is the last one: an active campaign must never lose
 * its keys to the new expiry.
 */

// Required first: several of these tests are keyspace-wide, so Redis must be on an
// isolated database before any client exists.
const { clearTestRedisKeys, testSessionId, getSharedRedisClient } = require('./helpers/testDb');

const test = require('node:test');
const assert = require('node:assert/strict');

const env = require('../config/env');

const {
  RETENTION_MULTIPLIER,
  sessionKeyTtlSeconds,
  recipientsKey,
  sentIndexKey,
  emailLogKey,
  allSessionKeys,
  touchSessionKeys,
  dropSessionKeys,
  dropEmailLogKey,
  adoptPersistentSessionKeys,
  dropAllEmailLogKeys
} = require('../utils/sessionKeys');

let redis;

test.before(async () => {
  redis = getSharedRedisClient();
  await clearTestRedisKeys();
});

test.after(async () => {
  await clearTestRedisKeys();
});

test.beforeEach(async () => {
  await clearTestRedisKeys();
});

test('TTL derives from DB_CLEANUP_DAYS and outlives the DB retention window', () => {
  const expected = env.dbCleanup.retentionSeconds * RETENTION_MULTIPLIER;

  assert.equal(sessionKeyTtlSeconds(), expected);
  assert.ok(
    sessionKeyTtlSeconds() > env.dbCleanup.retentionSeconds,
    'Redis must be the last copy to expire, never the first'
  );
});

test('touchSessionKeys applies the TTL to keys that exist and skips those that do not', async () => {
  const id = testSessionId('touch');
  await redis.rpush(recipientsKey(id), 'a@example.com');
  await redis.set(sentIndexKey(id), '1');
  // emaillog deliberately absent.

  await touchSessionKeys(redis, id);

  const ttl = sessionKeyTtlSeconds();
  const recipientsTtl = await redis.ttl(recipientsKey(id));
  const sentIndexTtl = await redis.ttl(sentIndexKey(id));

  assert.ok(recipientsTtl > 0 && recipientsTtl <= ttl, `recipients ttl was ${recipientsTtl}`);
  assert.ok(sentIndexTtl > 0 && sentIndexTtl <= ttl, `sentIndex ttl was ${sentIndexTtl}`);
  assert.equal(await redis.exists(emailLogKey(id)), 0, 'must not create a missing key');
});

test('touchSessionKeys slides an already-expiring key forward', async () => {
  const id = testSessionId('slide');
  await redis.set(sentIndexKey(id), '1', 'EX', 60);
  assert.ok((await redis.ttl(sentIndexKey(id))) <= 60);

  await touchSessionKeys(redis, id);

  const slid = await redis.ttl(sentIndexKey(id));
  assert.ok(slid > 60, `expected the TTL to be extended, got ${slid}`);
});

test('dropSessionKeys removes all three keys and reports the count', async () => {
  const id = testSessionId('drop-all');
  await redis.rpush(recipientsKey(id), 'a@example.com');
  await redis.set(sentIndexKey(id), '2');
  await redis.rpush(emailLogKey(id), '{}');

  assert.equal(await dropSessionKeys(redis, id), 3);

  for (const key of allSessionKeys(id)) {
    assert.equal(await redis.exists(key), 0, `${key} should be gone`);
  }
});

test('dropEmailLogKey removes only the log trail', async () => {
  const id = testSessionId('drop-log');
  await redis.rpush(recipientsKey(id), 'a@example.com');
  await redis.set(sentIndexKey(id), '2');
  await redis.rpush(emailLogKey(id), '{}');

  assert.equal(await dropEmailLogKey(redis, id), 1);

  assert.equal(await redis.exists(emailLogKey(id)), 0);
  assert.equal(await redis.exists(recipientsKey(id)), 1);
  assert.equal(await redis.exists(sentIndexKey(id)), 1);
});

test('adoptPersistentSessionKeys gives legacy TTL-less keys an expiry without deleting them', async () => {
  const id = testSessionId('legacy');

  // Exactly how these keys looked before this change: no expiry.
  await redis.rpush(recipientsKey(id), 'a@example.com');
  await redis.rpush(emailLogKey(id), '{}');
  assert.equal(await redis.ttl(recipientsKey(id)), -1, 'precondition: persistent');
  assert.equal(await redis.ttl(emailLogKey(id)), -1, 'precondition: persistent');

  const result = await adoptPersistentSessionKeys(redis);

  assert.ok(result.adopted >= 2, `expected at least 2 adopted, got ${result.adopted}`);
  assert.equal(result.ttlSeconds, sessionKeyTtlSeconds());

  assert.ok((await redis.ttl(recipientsKey(id))) > 0, 'recipients key should now expire');
  assert.ok((await redis.ttl(emailLogKey(id))) > 0, 'emaillog key should now expire');

  // Adoption must never destroy data.
  assert.equal(await redis.exists(recipientsKey(id)), 1);
  assert.deepEqual(await redis.lrange(recipientsKey(id), 0, -1), ['a@example.com']);
});

test('adoptPersistentSessionKeys leaves an existing TTL alone', async () => {
  const id = testSessionId('already-expiring');
  await redis.set(sentIndexKey(id), '1', 'EX', 120);

  await adoptPersistentSessionKeys(redis);

  const ttl = await redis.ttl(sentIndexKey(id));
  assert.ok(ttl > 0 && ttl <= 120, `expected the original 120s TTL to stand, got ${ttl}`);
});

test('dropAllEmailLogKeys clears trails and leaves recipient lists intact', async () => {
  const a = testSessionId('bulk-a');
  const b = testSessionId('bulk-b');
  await redis.rpush(emailLogKey(a), '{}');
  await redis.rpush(emailLogKey(b), '{}');
  await redis.rpush(recipientsKey(a), 'a@example.com');

  const deleted = await dropAllEmailLogKeys(redis);

  assert.ok(deleted >= 2, `expected at least 2 deleted, got ${deleted}`);
  assert.equal(await redis.exists(emailLogKey(a)), 0);
  assert.equal(await redis.exists(emailLogKey(b)), 0);
  assert.equal(await redis.exists(recipientsKey(a)), 1);
});

test('an active campaign never loses its keys: repeated touches keep the TTL near full', async () => {
  const id = testSessionId('active');
  const ttl = sessionKeyTtlSeconds();

  await redis.rpush(recipientsKey(id), 'a@example.com');
  await redis.set(sentIndexKey(id), '0', 'EX', ttl);

  // Stands in for a campaign sending batch after batch over a long period.
  for (let batch = 0; batch < 5; batch++) {
    await redis.set(sentIndexKey(id), String(batch * 1000), 'EX', ttl);
    await touchSessionKeys(redis, id);

    const remaining = await redis.ttl(recipientsKey(id));
    assert.ok(
      remaining > ttl - 60,
      `after batch ${batch} the recipient list had only ${remaining}s left of ${ttl}s`
    );
  }

  assert.equal(await redis.exists(recipientsKey(id)), 1);
  assert.equal(await redis.exists(sentIndexKey(id)), 1);
});
