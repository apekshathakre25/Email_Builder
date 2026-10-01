/**
 * Sequential campaign execution — the lane mechanics (utils/campaignQueue.js).
 *
 * THE REQUIREMENT. Two tabs, 70,000 addresses in one and 30,000 in the other. The
 * first sends; the second waits and then starts on its own once the first finishes.
 * Any number of tabs, in the order they asked.
 *
 * WHY THE BACKEND OWNS THIS. Sending happens in the worker processes off a shared Bull
 * queue, and before this nothing stopped two tabs submitting at once. Tab-to-tab
 * messaging (BroadcastChannel, localStorage events) cannot work here: it is invisible
 * to the workers, blind to whether a campaign is still sending, and gone as soon as a
 * tab closes. So the lane is Redis, and these tests drive Redis directly.
 *
 * These cover the state machine. tests/campaignQueueRoutes.test.js covers the HTTP
 * surface and the completion reconciler that decides when a turn is over.
 */

// Required first: it moves Redis onto an isolated database before anything that
// builds a client at require time can be loaded.
const {
  startTestDb,
  stopTestDb,
  clearCollections,
  clearTestRedisKeys,
  getSharedRedisClient
} = require('./helpers/testDb');

const test = require('node:test');
const assert = require('node:assert/strict');

const campaignQueue = require('../utils/campaignQueue');
const { STATES } = campaignQueue;

const USER = 'operator@example.com';
const OTHER_USER = 'someone.else@example.com';

let redis;

const claim = (campaignId, opts = {}) =>
  campaignQueue.claim(redis, { userId: USER, campaignId, ...opts });
const start = (campaignId, userId = USER) =>
  campaignQueue.markSending(redis, { userId, campaignId });
const release = (campaignId, state, userId = USER) =>
  campaignQueue.release(redis, { userId, campaignId, state });
const slot = (campaignId) => campaignQueue.readSlot(redis, campaignId);
const active = (userId = USER) => campaignQueue.readActive(redis, userId);
const lane = (userId = USER) => campaignQueue.readLane(redis, userId);

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
 * The headline requirement.
 * ================================================================== */

test('campaign A holds the lane and campaign B waits behind it', async () => {
  const a = await claim('campaign-A', { total: 70000 });
  const b = await claim('campaign-B', { total: 30000 });

  assert.equal(a.state, STATES.QUEUED, 'the first to ask is cleared immediately');
  assert.equal(a.position, 0);

  assert.equal(b.state, STATES.WAITING, 'the second must wait');
  assert.equal(b.position, 1, 'and is first in line');
  assert.equal(b.activeCampaignId, 'campaign-A');

  assert.equal(await active(), 'campaign-A');
  assert.deepEqual(await lane(), ['campaign-B']);
});

test('B does not start while A holds the lane', async () => {
  await claim('campaign-A');
  await claim('campaign-B');
  await start('campaign-A');

  const denied = await start('campaign-B');

  assert.equal(denied.ok, false, 'B must not be allowed to send alongside A');
  assert.equal(denied.code, 'DENIED');
  assert.equal(denied.activeCampaignId, 'campaign-A');
  assert.equal((await slot('campaign-B')).state, STATES.WAITING);
});

test('A completing releases the lane and promotes B automatically', async () => {
  await claim('campaign-A', { total: 70000 });
  await claim('campaign-B', { total: 30000 });
  await start('campaign-A');

  const { released, promotedCampaignId } = await release('campaign-A', STATES.COMPLETED);

  assert.equal(released, true);
  assert.equal(promotedCampaignId, 'campaign-B', 'B is promoted without anyone asking');
  assert.equal(await active(), 'campaign-B');
  assert.equal((await slot('campaign-A')).state, STATES.COMPLETED);
  assert.equal((await slot('campaign-B')).state, STATES.QUEUED, 'B is now cleared to send');
  assert.deepEqual(await lane(), [], 'and no longer queued');

  // And B can now do what it was refused a moment ago.
  assert.equal((await start('campaign-B')).ok, true);
});

test('any number of campaigns run in the order they asked', async () => {
  const ids = ['c1', 'c2', 'c3', 'c4', 'c5'];
  for (const id of ids) await claim(id);

  assert.equal(await active(), 'c1');
  assert.deepEqual(await lane(), ['c2', 'c3', 'c4', 'c5']);

  const order = [];
  for (let i = 0; i < ids.length; i++) {
    const holder = await active();
    order.push(holder);
    await start(holder);
    await release(holder, STATES.COMPLETED);
  }

  assert.deepEqual(order, ids, 'strict FIFO across five campaigns');
  assert.equal(await active(), null, 'lane empty at the end');
});

/* ================================================================== *
 * A campaign must never start twice.
 * ================================================================== */

test('the same campaign cannot be started twice', async () => {
  await claim('campaign-A');

  const first = await start('campaign-A');
  const second = await start('campaign-A');

  assert.equal(first.ok, true);
  assert.equal(second.ok, false, 'a second start is refused, not silently repeated');
  assert.equal(second.code, 'ALREADY');
});

test('two tabs claiming the same campaign share one place, not two', async () => {
  const first = await claim('campaign-A');
  const second = await claim('campaign-A');

  assert.equal(first.state, STATES.QUEUED);
  assert.equal(second.state, STATES.QUEUED, 'the second tab sees the same cleared state');
  assert.deepEqual(await lane(), [], 'and nothing was queued behind itself');

  // Only one of them can actually start it.
  assert.equal((await start('campaign-A')).ok, true);
  assert.equal((await start('campaign-A')).ok, false);
});

test('a campaign waiting twice keeps its original position', async () => {
  await claim('campaign-A');
  await claim('campaign-B');
  await claim('campaign-C');

  const again = await claim('campaign-B');

  assert.equal(again.position, 1, 'B stays ahead of C rather than moving to the back');
  assert.deepEqual(await lane(), ['campaign-B', 'campaign-C']);
});

test('concurrent claims from several web instances produce exactly one holder', async () => {
  // The four PM2 web instances can serve simultaneous claims. Without the Lua being
  // atomic, two could each read an empty lane and both take it.
  const results = await Promise.all([
    claim('r1'), claim('r2'), claim('r3'), claim('r4'), claim('r5')
  ]);

  const cleared = results.filter((r) => r.state === STATES.QUEUED);
  assert.equal(cleared.length, 1, 'exactly one campaign is cleared');
  assert.equal((await lane()).length, 4, 'the other four are queued');
});

/* ================================================================== *
 * Refresh recovery.
 * ================================================================== */

test('a refresh while sending reports SENDING, it does not restart the campaign', async () => {
  await claim('campaign-A', { total: 70000 });
  await start('campaign-A');

  // The reload re-claims with the same id.
  const afterReload = await claim('campaign-A', { total: 70000 });

  assert.equal(afterReload.state, STATES.SENDING, 'recognised as already running');
  assert.equal((await slot('campaign-A')).state, STATES.SENDING);
  assert.equal(await active(), 'campaign-A', 'still the holder');
  assert.deepEqual(await lane(), [], 'and not queued behind itself');
});

test('a refresh while waiting recovers the same position', async () => {
  await claim('campaign-A');
  await claim('campaign-B');
  await claim('campaign-C');

  const recovered = await claim('campaign-B');

  assert.equal(recovered.state, STATES.WAITING, 'still waiting');
  assert.equal(recovered.position, 1, 'in the same place');
  assert.equal(recovered.activeCampaignId, 'campaign-A');
});

test('a claim on a terminal campaign reports the terminal state', async () => {
  await claim('campaign-A');
  await start('campaign-A');
  await release('campaign-A', STATES.COMPLETED);

  const again = await claim('campaign-A');
  assert.equal(again.state, STATES.COMPLETED, 'a finished campaign is not re-queued silently');
});

/* ================================================================== *
 * Failure and cancellation.
 * ================================================================== */

test('a failed campaign releases the lane and is not marked completed', async () => {
  await claim('campaign-A');
  await claim('campaign-B');
  await start('campaign-A');

  const { promotedCampaignId } = await release('campaign-A', STATES.FAILED);

  assert.equal(promotedCampaignId, 'campaign-B', 'the next campaign is not left stuck');
  assert.equal((await slot('campaign-A')).state, STATES.FAILED);
  assert.notEqual((await slot('campaign-A')).state, STATES.COMPLETED);
});

test('a cancelled campaign releases the lane', async () => {
  await claim('campaign-A');
  await claim('campaign-B');
  await start('campaign-A');

  const { promotedCampaignId } = await release('campaign-A', STATES.CANCELLED);

  assert.equal(promotedCampaignId, 'campaign-B');
  assert.equal((await slot('campaign-A')).state, STATES.CANCELLED);
});

test('cancelling a campaign that is only waiting removes it from the queue', async () => {
  await claim('campaign-A');
  await claim('campaign-B');
  await claim('campaign-C');

  const result = await release('campaign-B', STATES.CANCELLED);

  assert.equal(result.code, 'NOT_ACTIVE', 'B never held the lane');
  assert.equal(await active(), 'campaign-A', 'and A keeps it');
  assert.deepEqual(await lane(), ['campaign-C'], 'B is gone, C moves up');
  assert.equal((await slot('campaign-B')).state, STATES.CANCELLED);
});

test('release only accepts a terminal state', async () => {
  await claim('campaign-A');
  await assert.rejects(() => release('campaign-A', STATES.SENDING), /terminal state/);
});

/* ================================================================== *
 * Isolation and bookkeeping.
 * ================================================================== */

test('one operator\'s lane does not block another\'s', async () => {
  await claim('mine-A');
  await campaignQueue.claim(redis, { userId: OTHER_USER, campaignId: 'theirs-A' });

  assert.equal(await active(USER), 'mine-A');
  assert.equal(await active(OTHER_USER), 'theirs-A', 'a separate operator sends immediately');
  assert.equal((await start('theirs-A', OTHER_USER)).ok, true);
});

test('progress bookkeeping records the settled count for stall detection', async () => {
  await claim('campaign-A', { total: 100 });
  await start('campaign-A');

  await campaignQueue.noteProgress(redis, { userId: USER, campaignId: 'campaign-A', settled: 42 });

  const s = await slot('campaign-A');
  assert.equal(s.lastSettled, 42);
  assert.ok(s.lastProgressAt, 'and when it was last seen moving');
});

test('the lane claim carries an expiry, so an abandoned hold cannot block forever', async () => {
  await claim('campaign-A');

  const ttl = await redis.ttl(campaignQueue.activeKey(USER));
  assert.ok(ttl > 0, 'claim expires');
  assert.ok(ttl <= campaignQueue.ACTIVE_TTL_SECONDS);
});

test('the total is recorded on the slot for reporting', async () => {
  await claim('campaign-A', { total: 70000 });
  assert.equal((await slot('campaign-A')).total, 70000);
});

test('readSlot returns null for a campaign that never claimed a lane', async () => {
  assert.equal(await slot('never-seen'), null);
});

test('dropSlot forgets a campaign entirely', async () => {
  await claim('campaign-A');
  await claim('campaign-B');

  await campaignQueue.dropSlot(redis, { userId: USER, campaignId: 'campaign-B' });

  assert.equal(await slot('campaign-B'), null);
  assert.deepEqual(await lane(), [], 'and it is out of the queue');
});
