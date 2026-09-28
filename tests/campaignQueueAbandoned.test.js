/**
 * A closed waiting tab must not send, and must not stall the lane.
 *
 * THE RULE. A waiting campaign belongs to the tab that staged it — the payload lives in
 * that tab's form. So if the tab is gone when its turn comes, the campaign must NOT
 * start. But a refreshed tab is still there and must keep its place.
 *
 * HOW THE TWO ARE TOLD APART. A waiting tab polls GET /campaign-lane every 2s, and each
 * poll stamps `lastSeenMs` on its slot. That poll is the liveness signal. A reload misses
 * one or two polls; a closed tab misses every one of them from then on. Nothing else can
 * distinguish them: `pagehide` fires identically for a refresh and a close, which is why
 * the original "leave" beacon was wrong — it cancelled the campaigns of tabs that were
 * merely reloading, and a cancelled slot refuses to be re-queued, so those campaigns
 * could not be restarted at all.
 *
 * WHAT MUST NOT HAPPEN, and is asserted here:
 *   - an abandoned campaign starting on its own with nobody watching;
 *   - an abandoned campaign being promoted and then holding the lane in QUEUED forever,
 *     which blocked everything behind it until the claim's six-hour expiry;
 *   - a refreshed tab losing its turn.
 */

// Required first: it moves Redis onto an isolated database before routes/sendemails
// (which builds a client at require time) can be loaded.
const {
  startTestDb,
  stopTestDb,
  clearCollections,
  clearTestRedisKeys,
  getSharedRedisClient
} = require('./helpers/testDb');

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const EmailLog = require('../models/EmailLog');
const campaignQueue = require('../utils/campaignQueue');
const { STATES } = campaignQueue;
const { seedEmailStats } = require('../utils/sessionKeys');

const campaignQueueRouter = require('../routes/campaignQueue');

const USER = 'operator@example.com';

let server;
let baseUrl;
let redis;

function buildTestApp() {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = { email: USER, name: 'Operator' };
    next();
  });
  app.use('/', campaignQueueRouter);
  return app;
}

const post = async (path, body) => {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  });
  return { status: res.status, body: await res.json() };
};

const getLane = async (campaignId) => {
  const qs = campaignId ? `?campaignId=${encodeURIComponent(campaignId)}` : '';
  const res = await fetch(`${baseUrl}/campaign-lane${qs}`);
  return { status: res.status, body: await res.json() };
};

async function seedCampaign(campaignId, total) {
  await redis.del(`recipients:${campaignId}`);
  const addresses = Array.from({ length: total }, (_, i) => `r${i}@example.com`);
  if (addresses.length) await redis.rpush(`recipients:${campaignId}`, ...addresses);

  await EmailLog.findOneAndUpdate(
    { sessionId: campaignId },
    {
      sessionId: campaignId,
      fromEmail: 'from@example.com',
      subject: 'Abandonment',
      totalRecipients: total,
      pendingCount: total,
      status: 'in_progress'
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
}

async function settleAll(campaignId, total) {
  await seedEmailStats(redis, campaignId, { sent: 0, failed: 0 });
  await redis.hincrby(`emailstats:${campaignId}`, 'sent', total);
}

/** Simulates a tab that has been closed: its heartbeat stops. */
async function closeTab(campaignId) {
  const longAgo = Date.now() - (campaignQueue.HEARTBEAT_STALE_MS + 5000);
  await redis.hset(campaignQueue.slotKey(campaignId), 'lastSeenMs', String(longAgo));
}

/** Simulates a tab that is still open: a fresh poll. */
const keepAlive = (campaignId) => campaignQueue.heartbeat(redis, campaignId);

const slot = (campaignId) => campaignQueue.readSlot(redis, campaignId);
const active = () => campaignQueue.readActive(redis, USER);
const lane = () => campaignQueue.readLane(redis, USER);
const statusOf = async (campaignId) => {
  const log = await EmailLog.findOne({ sessionId: campaignId }).lean();
  return log ? log.status : null;
};

test.before(async () => {
  await startTestDb();
  redis = getSharedRedisClient();
  await clearTestRedisKeys();

  const app = buildTestApp();
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await clearTestRedisKeys();
  await stopTestDb();
});

test.beforeEach(async () => {
  await clearCollections();
  await clearTestRedisKeys();
});

/* ================================================================== *
 * 1. Tab B open -> A completes -> B starts.
 * ================================================================== */

test('B is still open when A completes, so B starts', async () => {
  await seedCampaign('camp-A', 70);
  await seedCampaign('camp-B', 30);

  await post('/campaign-lane/claim', { campaignId: 'camp-A', total: 70 });
  await post('/campaign-lane/start', { campaignId: 'camp-A' });
  await post('/campaign-lane/claim', { campaignId: 'camp-B', total: 30 });

  // B's tab keeps polling, which is what proves it is open.
  await keepAlive('camp-B');
  await settleAll('camp-A', 70);

  const released = await getLane('camp-B');

  assert.equal(released.body.reconciled, STATES.COMPLETED);
  assert.equal(released.body.cleared, true, 'B is cleared to send');
  assert.equal(await active(), 'camp-B');
  assert.equal((await post('/campaign-lane/start', { campaignId: 'camp-B' })).status, 200);
});

/* ================================================================== *
 * 2. Tab B closed while waiting -> A completes -> B does NOT start.
 * ================================================================== */

test('B was closed while waiting, so it is not promoted when A completes', async () => {
  await seedCampaign('camp-A', 70);
  await seedCampaign('camp-B', 30);

  await post('/campaign-lane/claim', { campaignId: 'camp-A', total: 70 });
  await post('/campaign-lane/start', { campaignId: 'camp-A' });
  await post('/campaign-lane/claim', { campaignId: 'camp-B', total: 30 });

  await closeTab('camp-B');
  await settleAll('camp-A', 70);

  // A's own tab polls and reconciles; B must not be handed the lane.
  const afterA = await getLane('camp-A');

  assert.equal(afterA.body.reconciled, STATES.COMPLETED, 'A finished');
  assert.equal(await active(), null, 'the lane is FREE, not held by the closed tab');
  assert.equal((await slot('camp-B')).state, STATES.CANCELLED, 'B is cancelled, not started');
  assert.equal((await slot('camp-B')).abandoned, true, 'and marked as abandoned');
  assert.deepEqual(await lane(), [], 'no stale entry left in the lane');

  // The decisive assertion: B cannot send.
  const denied = await post('/campaign-lane/start', { campaignId: 'camp-B' });
  assert.equal(denied.status, 409, 'a closed tab\'s campaign cannot start');
});

test('a closed tab leaves no stuck lane entry and does not block the next campaign', async () => {
  await seedCampaign('camp-A', 70);
  await seedCampaign('camp-B', 30);
  await seedCampaign('camp-C', 10);

  await post('/campaign-lane/claim', { campaignId: 'camp-A', total: 70 });
  await post('/campaign-lane/start', { campaignId: 'camp-A' });
  await post('/campaign-lane/claim', { campaignId: 'camp-B', total: 30 });
  await post('/campaign-lane/claim', { campaignId: 'camp-C', total: 10 });

  // B's tab closed; C's is still open.
  await closeTab('camp-B');
  await keepAlive('camp-C');
  await settleAll('camp-A', 70);

  const afterA = await getLane('camp-C');

  assert.equal(await active(), 'camp-C', 'C is promoted, skipping the closed B');
  assert.equal(afterA.body.cleared, true, 'and C may send');
  assert.equal((await slot('camp-B')).state, STATES.CANCELLED);
  assert.deepEqual(await lane(), [], 'the queue is clean');
});

test('several closed tabs in a row are all skipped', async () => {
  for (const [id, n] of [['camp-A', 10], ['camp-B', 10], ['camp-C', 10], ['camp-D', 10]]) {
    await seedCampaign(id, n);
  }

  for (const id of ['camp-A', 'camp-B', 'camp-C', 'camp-D']) {
    await post('/campaign-lane/claim', { campaignId: id, total: 10 });
  }
  await post('/campaign-lane/start', { campaignId: 'camp-A' });

  await closeTab('camp-B');
  await closeTab('camp-C');
  await keepAlive('camp-D');
  await settleAll('camp-A', 10);

  await getLane('camp-D');

  assert.equal(await active(), 'camp-D', 'the first still-open tab gets the lane');
  assert.equal((await slot('camp-B')).state, STATES.CANCELLED);
  assert.equal((await slot('camp-C')).state, STATES.CANCELLED);
  assert.deepEqual(await lane(), []);
});

test('a tab closed after being promoted does not hold the lane', async () => {
  // The narrow race: B is promoted, then its tab closes before it can submit. Nothing
  // used to release a QUEUED holder, so everything behind it waited six hours.
  await seedCampaign('camp-A', 10);
  await seedCampaign('camp-B', 10);
  await seedCampaign('camp-C', 10);

  for (const id of ['camp-A', 'camp-B', 'camp-C']) {
    await post('/campaign-lane/claim', { campaignId: id, total: 10 });
  }
  await post('/campaign-lane/start', { campaignId: 'camp-A' });

  await keepAlive('camp-B');
  await settleAll('camp-A', 10);
  await getLane('camp-B');

  assert.equal(await active(), 'camp-B', 'B was promoted while still open');
  assert.equal((await slot('camp-B')).state, STATES.QUEUED);

  // Now B's tab closes without submitting.
  await closeTab('camp-B');
  await keepAlive('camp-C');

  const recovered = await getLane('camp-C');

  assert.equal(recovered.body.reconciled, STATES.CANCELLED, 'B is given up, not waited on');
  assert.equal((await slot('camp-B')).state, STATES.CANCELLED);
  assert.equal(await active(), 'camp-C', 'C gets the lane instead of stalling');
  assert.equal(recovered.body.cleared, true);
});

test('an abandoned waiting campaign is never marked completed', async () => {
  await seedCampaign('camp-A', 70);
  await seedCampaign('camp-B', 30);

  await post('/campaign-lane/claim', { campaignId: 'camp-A', total: 70 });
  await post('/campaign-lane/start', { campaignId: 'camp-A' });
  await post('/campaign-lane/claim', { campaignId: 'camp-B', total: 30 });

  await closeTab('camp-B');
  await settleAll('camp-A', 70);
  await getLane('camp-A');

  // It never ran, so its durable record must not claim otherwise.
  assert.notEqual(await statusOf('camp-B'), 'completed');
  assert.equal(await statusOf('camp-B'), 'in_progress', 'still pending for a later send');
  assert.equal((await slot('camp-B')).state, STATES.CANCELLED);
});

/* ================================================================== *
 * 3. Refresh B while waiting -> B keeps its place and still starts.
 * ================================================================== */

test('refreshing a waiting tab keeps its place and it still starts', async () => {
  await seedCampaign('camp-A', 70);
  await seedCampaign('camp-B', 30);

  await post('/campaign-lane/claim', { campaignId: 'camp-A', total: 70 });
  await post('/campaign-lane/start', { campaignId: 'camp-A' });
  await post('/campaign-lane/claim', { campaignId: 'camp-B', total: 30 });

  // A refresh: the page is torn down and re-claims on load. No "leave" is sent — that
  // is the bug this replaced, because it cancelled refreshing tabs.
  const reclaimed = await post('/campaign-lane/claim', { campaignId: 'camp-B', total: 30 });

  assert.equal(reclaimed.body.state, STATES.WAITING, 'still waiting, not cancelled');
  assert.equal(reclaimed.body.position, 1, 'and still in the same place');

  await settleAll('camp-A', 70);
  const released = await getLane('camp-B');

  assert.equal(released.body.cleared, true, 'a refreshed tab still gets its turn');
  assert.equal(await active(), 'camp-B');
  assert.equal((await post('/campaign-lane/start', { campaignId: 'camp-B' })).status, 200);
});

test('a refresh slower than the heartbeat window can still re-claim its turn', async () => {
  await seedCampaign('camp-A', 70);
  await seedCampaign('camp-B', 30);

  await post('/campaign-lane/claim', { campaignId: 'camp-A', total: 70 });
  await post('/campaign-lane/start', { campaignId: 'camp-A' });
  await post('/campaign-lane/claim', { campaignId: 'camp-B', total: 30 });

  // A very slow reload: the server has already given up on B.
  await closeTab('camp-B');
  await getLane('camp-A');
  assert.equal((await slot('camp-B')).state, STATES.CANCELLED, 'dropped while gone');

  // The tab comes back and re-claims, which is what campaign-sequencer.js does on load
  // when its sessionStorage intent marker is present. A is still sending, so B rejoins
  // the queue rather than being told its campaign is dead.
  const back = await post('/campaign-lane/claim', { campaignId: 'camp-B', total: 30 });

  assert.equal(back.body.state, STATES.WAITING, 'back in line behind the sending campaign');
  assert.equal(back.body.position, 1);

  // And it still gets its turn, which is the point: the slow reload cost it nothing.
  await settleAll('camp-A', 70);
  const released = await getLane('camp-B');

  assert.equal(released.body.cleared, true, 'recovered fully');
  assert.equal(await active(), 'camp-B');
  assert.equal((await post('/campaign-lane/start', { campaignId: 'camp-B' })).status, 200);
});

test('a poll is a heartbeat: polling alone keeps a waiting campaign eligible', async () => {
  await seedCampaign('camp-A', 70);
  await seedCampaign('camp-B', 30);

  await post('/campaign-lane/claim', { campaignId: 'camp-A', total: 70 });
  await post('/campaign-lane/start', { campaignId: 'camp-A' });
  await post('/campaign-lane/claim', { campaignId: 'camp-B', total: 30 });

  await closeTab('camp-B');            // pretend it went quiet
  await getLane('camp-B');             // ...then it polls, which revives the heartbeat

  const s = await slot('camp-B');
  assert.equal(campaignQueue.isStale(s), false, 'the poll refreshed liveness');

  // And it is still queued rather than having been pruned by its own poll.
  assert.deepEqual(await lane(), ['camp-B'], 'a tab cannot be pruned by the request that proves it is alive');
});

/* ================================================================== *
 * 4. No duplicate starts, no stale lane entries.
 * ================================================================== */

test('a promoted campaign still cannot be started twice', async () => {
  await seedCampaign('camp-A', 10);
  await seedCampaign('camp-B', 10);

  await post('/campaign-lane/claim', { campaignId: 'camp-A', total: 10 });
  await post('/campaign-lane/start', { campaignId: 'camp-A' });
  await post('/campaign-lane/claim', { campaignId: 'camp-B', total: 10 });

  await keepAlive('camp-B');
  await settleAll('camp-A', 10);
  await getLane('camp-B');

  assert.equal((await post('/campaign-lane/start', { campaignId: 'camp-B' })).status, 200);
  assert.equal((await post('/campaign-lane/start', { campaignId: 'camp-B' })).status, 409);
});

test('an abandoned campaign cannot be revived by a stale start call', async () => {
  await seedCampaign('camp-A', 10);
  await seedCampaign('camp-B', 10);

  await post('/campaign-lane/claim', { campaignId: 'camp-A', total: 10 });
  await post('/campaign-lane/start', { campaignId: 'camp-A' });
  await post('/campaign-lane/claim', { campaignId: 'camp-B', total: 10 });

  await closeTab('camp-B');
  await settleAll('camp-A', 10);
  await getLane('camp-A');

  // An in-flight request from the dying tab arriving after it was dropped.
  const late = await post('/campaign-lane/start', { campaignId: 'camp-B' });
  assert.equal(late.status, 409, 'refused: it does not hold the lane');
  assert.equal((await slot('camp-B')).state, STATES.CANCELLED);
});

test('pruning is idempotent and leaves open tabs alone', async () => {
  await seedCampaign('camp-A', 10);
  await seedCampaign('camp-B', 10);
  await seedCampaign('camp-C', 10);

  for (const id of ['camp-A', 'camp-B', 'camp-C']) {
    await post('/campaign-lane/claim', { campaignId: id, total: 10 });
  }
  await post('/campaign-lane/start', { campaignId: 'camp-A' });

  await closeTab('camp-B');
  await keepAlive('camp-C');

  const first = await campaignQueue.pruneAbandonedWaiting(redis, USER);
  const second = await campaignQueue.pruneAbandonedWaiting(redis, USER);

  assert.deepEqual(first, ['camp-B'], 'only the closed tab is dropped');
  assert.deepEqual(second, [], 'running it again changes nothing');
  assert.deepEqual(await lane(), ['camp-C'], 'the open tab keeps its place');
});

test('the abandoned ids are reported so the reason is visible', async () => {
  await seedCampaign('camp-A', 10);
  await seedCampaign('camp-B', 10);

  await post('/campaign-lane/claim', { campaignId: 'camp-A', total: 10 });
  await post('/campaign-lane/start', { campaignId: 'camp-A' });
  await post('/campaign-lane/claim', { campaignId: 'camp-B', total: 10 });
  await closeTab('camp-B');

  const polled = await getLane('camp-A');
  assert.deepEqual(polled.body.prunedCampaignIds, ['camp-B'], 'what this poll dropped');
  assert.equal((await slot('camp-B')).abandoned, true, 'and why B is no longer queued');
});

/* ================================================================== *
 * A SENDING campaign is NOT governed by its tab.
 * ================================================================== */

test('closing a sending campaign\'s tab does not stop it', async () => {
  // Deliberate: once jobs are enqueued the workers own the campaign. Halting a 70,000
  // recipient send because a browser was closed would be a far worse failure, and the
  // operator still has explicit Stop Sending. Liveness is only consulted for WAITING
  // and QUEUED.
  await seedCampaign('camp-A', 70);
  await post('/campaign-lane/claim', { campaignId: 'camp-A', total: 70 });
  await post('/campaign-lane/start', { campaignId: 'camp-A' });

  await closeTab('camp-A');

  const polled = await getLane(null);

  assert.equal(polled.body.reconciled, null, 'not cancelled for being unwatched');
  assert.equal(await active(), 'camp-A', 'it keeps the lane and keeps sending');
  assert.equal(await statusOf('camp-A'), 'in_progress');
});

test('a sending campaign whose tab closed still completes and frees the lane', async () => {
  await seedCampaign('camp-A', 70);
  await seedCampaign('camp-B', 30);

  await post('/campaign-lane/claim', { campaignId: 'camp-A', total: 70 });
  await post('/campaign-lane/start', { campaignId: 'camp-A' });
  await post('/campaign-lane/claim', { campaignId: 'camp-B', total: 30 });

  await closeTab('camp-A');            // A's tab is gone
  await keepAlive('camp-B');           // B's is open
  await settleAll('camp-A', 70);       // the workers finished it anyway

  const released = await getLane('camp-B');

  assert.equal(released.body.reconciled, STATES.COMPLETED, 'completion is judged by progress');
  assert.equal(await statusOf('camp-A'), 'completed');
  assert.equal(released.body.cleared, true, 'and B proceeds');
});
