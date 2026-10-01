/**
 * Sequential campaign execution — the HTTP surface and the completion reconciler.
 *
 * tests/campaignQueue.test.js covers the lane state machine. This covers the part that
 * decides when a turn is OVER, which is the piece that did not exist before: nothing in
 * this application ever concluded that a campaign had finished. `EmailLog.status` never
 * became 'completed' (the only writer, `addEntry`, has no call sites — BatchLogger uses
 * a raw `$inc` that bypasses it), there is no end-of-campaign hook on the queue, and the
 * sole "finished" judgement lived in the browser as `sent + failed >= total`.
 *
 * So reconciliation is server-side and lazy: every poll of GET /campaign-lane
 * re-evaluates the holder before answering, using the same readCampaignProgress the
 * /status endpoint reports from. That is what makes the sequencing work when the tab
 * that started the campaign has been closed — the WAITING tab's own poll is what
 * notices the one ahead of it has finished.
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
const { stopCampaign } = require('../utils/campaignStop');
const { seedEmailStats } = require('../utils/sessionKeys');

const campaignQueueRouter = require('../routes/campaignQueue');

const USER = 'operator@example.com';

let server;
let baseUrl;
let redis;

function buildTestApp() {
  const app = express();
  app.use(express.json());

  // The router is mounted behind authenticateToken in app.js and reads
  // req.user.email; this stands in for that without involving JWTs.
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

/**
 * A campaign the reconciler can read: a recipient list of `total` addresses and an
 * EmailLog, mirroring what /send-email creates.
 */
async function seedCampaign(campaignId, { total, sent = 0, failed = 0 } = {}) {
  await redis.del(`recipients:${campaignId}`);
  const addresses = Array.from({ length: total }, (_, i) => `r${i}@example.com`);
  if (addresses.length) await redis.rpush(`recipients:${campaignId}`, ...addresses);

  await EmailLog.findOneAndUpdate(
    { sessionId: campaignId },
    {
      sessionId: campaignId,
      fromEmail: 'from@example.com',
      subject: 'Sequencing',
      totalRecipients: total,
      sentCount: sent,
      failedCount: failed,
      pendingCount: Math.max(0, total - sent - failed),
      status: 'in_progress'
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
}

/** Advances a campaign's live tally, the way the worker does per email. */
async function recordSettled(campaignId, { sent = 0, failed = 0 } = {}) {
  await seedEmailStats(redis, campaignId, { sent: 0, failed: 0 });
  if (sent) await redis.hincrby(`emailstats:${campaignId}`, 'sent', sent);
  if (failed) await redis.hincrby(`emailstats:${campaignId}`, 'failed', failed);
}

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
 * The requirement, end to end over HTTP.
 * ================================================================== */

test('A sends, B waits, A completes, B is released automatically', async () => {
  await seedCampaign('camp-A', { total: 70 });
  await seedCampaign('camp-B', { total: 30 });

  // Tab 1 claims and starts.
  const claimA = await post('/campaign-lane/claim', { campaignId: 'camp-A', total: 70 });
  assert.equal(claimA.body.state, STATES.QUEUED);
  assert.equal(claimA.body.cleared, true, 'tab 1 may send immediately');
  assert.equal((await post('/campaign-lane/start', { campaignId: 'camp-A' })).status, 200);

  // Tab 2 claims and is told to wait.
  const claimB = await post('/campaign-lane/claim', { campaignId: 'camp-B', total: 30 });
  assert.equal(claimB.body.state, STATES.WAITING);
  assert.equal(claimB.body.cleared, false, 'tab 2 must not send yet');
  assert.equal(claimB.body.position, 1);
  assert.equal(claimB.body.activeCampaignId, 'camp-A');

  // Tab 2 polls while A is only part-way through.
  await recordSettled('camp-A', { sent: 40 });
  const midway = await getLane('camp-B');
  assert.equal(midway.body.cleared, false, 'still waiting at 40/70');
  assert.equal(midway.body.state, STATES.WAITING);

  // A finishes. Tab 2's own poll is what notices.
  await recordSettled('camp-A', { sent: 28, failed: 2 }); // 70/70 settled
  const released = await getLane('camp-B');

  assert.equal(released.body.reconciled, STATES.COMPLETED, 'the poll reconciled A');
  assert.equal(released.body.cleared, true, 'and B is now cleared to send');
  assert.equal(released.body.state, STATES.QUEUED);
  assert.equal(released.body.activeCampaignId, 'camp-B');

  // The durable record is finally marked — nothing did this before.
  assert.equal(await statusOf('camp-A'), 'completed');

  // And B can start.
  assert.equal((await post('/campaign-lane/start', { campaignId: 'camp-B' })).status, 200);
});

test('B cannot start before A completes, even if it asks directly', async () => {
  await seedCampaign('camp-A', { total: 70 });
  await seedCampaign('camp-B', { total: 30 });

  await post('/campaign-lane/claim', { campaignId: 'camp-A', total: 70 });
  await post('/campaign-lane/start', { campaignId: 'camp-A' });
  await post('/campaign-lane/claim', { campaignId: 'camp-B', total: 30 });

  const denied = await post('/campaign-lane/start', { campaignId: 'camp-B' });

  assert.equal(denied.status, 409, 'refused with a conflict, not silently allowed');
  assert.equal(denied.body.success, false);
  assert.equal(denied.body.activeCampaignId, 'camp-A');
});

test('three campaigns run strictly in order', async () => {
  for (const [id, total] of [['c1', 10], ['c2', 10], ['c3', 10]]) {
    await seedCampaign(id, { total });
  }

  for (const id of ['c1', 'c2', 'c3']) {
    await post('/campaign-lane/claim', { campaignId: id, total: 10 });
  }

  const order = [];
  for (let i = 0; i < 3; i++) {
    const lane = await getLane('c3');
    const holder = lane.body.activeCampaignId;
    order.push(holder);

    await post('/campaign-lane/start', { campaignId: holder });
    await recordSettled(holder, { sent: 10 });
    await getLane('c3'); // the poll that reconciles the holder
  }

  assert.deepEqual(order, ['c1', 'c2', 'c3']);
  assert.equal(await statusOf('c1'), 'completed');
  assert.equal(await statusOf('c2'), 'completed');
});

/* ================================================================== *
 * A campaign must not start twice, and a refresh must not duplicate it.
 * ================================================================== */

test('the same campaign cannot be started twice over HTTP', async () => {
  await seedCampaign('camp-A', { total: 70 });
  await post('/campaign-lane/claim', { campaignId: 'camp-A', total: 70 });

  assert.equal((await post('/campaign-lane/start', { campaignId: 'camp-A' })).status, 200);

  const second = await post('/campaign-lane/start', { campaignId: 'camp-A' });
  assert.equal(second.status, 409);
  assert.equal(second.body.code, 'ALREADY');
});

test('refreshing a sending tab reports SENDING and does not re-queue it', async () => {
  await seedCampaign('camp-A', { total: 70 });
  await post('/campaign-lane/claim', { campaignId: 'camp-A', total: 70 });
  await post('/campaign-lane/start', { campaignId: 'camp-A' });
  await recordSettled('camp-A', { sent: 20 });

  // The reload re-claims.
  const reclaim = await post('/campaign-lane/claim', { campaignId: 'camp-A', total: 70 });

  assert.equal(reclaim.body.state, STATES.SENDING);
  assert.equal(reclaim.body.cleared, false, 'not cleared to submit again');
  assert.deepEqual(reclaim.body.waiting, [], 'and not queued behind itself');
  assert.equal(reclaim.body.activeCampaignId, 'camp-A', 'still the holder');
});

test('refreshing a waiting tab restores its waiting state and position', async () => {
  await seedCampaign('camp-A', { total: 70 });
  await seedCampaign('camp-B', { total: 30 });
  await seedCampaign('camp-C', { total: 5 });

  await post('/campaign-lane/claim', { campaignId: 'camp-A', total: 70 });
  await post('/campaign-lane/start', { campaignId: 'camp-A' });
  await post('/campaign-lane/claim', { campaignId: 'camp-B', total: 30 });
  await post('/campaign-lane/claim', { campaignId: 'camp-C', total: 5 });

  // Tab B reloads: it re-claims on load, exactly as campaign-sequencer.js does.
  const recovered = await post('/campaign-lane/claim', { campaignId: 'camp-B', total: 30 });

  assert.equal(recovered.body.state, STATES.WAITING, 'still waiting after the refresh');
  assert.equal(recovered.body.position, 1, 'and still ahead of C');
  assert.deepEqual(recovered.body.waiting, ['camp-B', 'camp-C']);

  // A plain poll recovers the same view without claiming.
  const polled = await getLane('camp-B');
  assert.equal(polled.body.state, STATES.WAITING);
  assert.equal(polled.body.position, 1);
});

/* ================================================================== *
 * Stop, failure and crash.
 * ================================================================== */

test('a stopped campaign releases the lane so the next one is not deadlocked', async () => {
  await seedCampaign('camp-A', { total: 70 });
  await seedCampaign('camp-B', { total: 30 });

  await post('/campaign-lane/claim', { campaignId: 'camp-A', total: 70 });
  await post('/campaign-lane/start', { campaignId: 'camp-A' });
  await post('/campaign-lane/claim', { campaignId: 'camp-B', total: 30 });

  await recordSettled('camp-A', { sent: 20 });
  await stopCampaign(redis, 'camp-A', { stoppedBy: USER, reason: 'operator clicked Stop' });

  const lane = await getLane('camp-B');

  assert.equal(lane.body.reconciled, STATES.CANCELLED, 'the stop is terminal for this run');
  assert.equal(lane.body.cleared, true, 'and B proceeds rather than waiting forever');
  assert.equal(lane.body.activeCampaignId, 'camp-B');

  // A stop is NOT a completion: the campaign keeps its pending recipients and can be
  // resubmitted, which is the existing stop contract.
  assert.notEqual(await statusOf('camp-A'), 'completed');
});

test('a campaign is never marked completed when it has not reached everyone', async () => {
  await seedCampaign('camp-A', { total: 70 });
  await post('/campaign-lane/claim', { campaignId: 'camp-A', total: 70 });
  await post('/campaign-lane/start', { campaignId: 'camp-A' });
  await recordSettled('camp-A', { sent: 69 });

  const lane = await getLane('camp-A');

  assert.equal(lane.body.reconciled, null, '69 of 70 is not finished');
  assert.equal(await statusOf('camp-A'), 'in_progress');
  assert.equal(lane.body.activeCampaignId, 'camp-A', 'and the lane is still held');
});

test('a campaign with an unresolvable total is not read as finished', async () => {
  // total 0 must never satisfy "settled >= total", or the lane would be released
  // before a single email had been sent.
  await redis.del('recipients:camp-empty');
  await post('/campaign-lane/claim', { campaignId: 'camp-empty', total: 0 });
  await post('/campaign-lane/start', { campaignId: 'camp-empty' });

  const lane = await getLane('camp-empty');
  assert.equal(lane.body.reconciled, null, 'not treated as complete');
});

test('a stalled campaign is marked failed, not completed, and releases the lane', async () => {
  await seedCampaign('camp-A', { total: 70 });
  await seedCampaign('camp-B', { total: 30 });

  await post('/campaign-lane/claim', { campaignId: 'camp-A', total: 70 });
  await post('/campaign-lane/start', { campaignId: 'camp-A' });
  await post('/campaign-lane/claim', { campaignId: 'camp-B', total: 30 });

  // 50 entries were released to the queue but only 30 ever came back, and nothing has
  // settled since: the jobs were lost. The watermark is what makes this a stall rather
  // than a pause — a campaign paused by Limit to Send has settled everything it
  // released, so `sentIndex` would equal `settled`.
  await redis.set(`sentIndex:camp-A`, '50');
  await recordSettled('camp-A', { sent: 30 });
  await getLane('camp-B'); // records progress at 30

  const longAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  await redis.hset(campaignQueue.slotKey('camp-A'), 'lastProgressAt', longAgo, 'lastSettled', '30');

  const lane = await getLane('camp-B');

  assert.equal(lane.body.reconciled, STATES.FAILED, 'judged failed, not completed');
  assert.equal(await statusOf('camp-A'), 'failed');
  assert.notEqual(await statusOf('camp-A'), 'completed');
  assert.equal(lane.body.cleared, true, 'B does not wait forever on a dead campaign');
});

test('a slow campaign is not mistaken for a stalled one', async () => {
  await seedCampaign('camp-A', { total: 70 });
  await post('/campaign-lane/claim', { campaignId: 'camp-A', total: 70 });
  await post('/campaign-lane/start', { campaignId: 'camp-A' });
  await recordSettled('camp-A', { sent: 30 });
  await getLane('camp-A');

  // Stale progress, but a recent-enough gap that a paced campaign could produce it.
  const recently = new Date(Date.now() - 5 * 1000).toISOString();
  await redis.hset(campaignQueue.slotKey('camp-A'), 'lastProgressAt', recently, 'lastSettled', '30');

  const lane = await getLane('camp-A');
  assert.equal(lane.body.reconciled, null, 'still running');
  assert.equal(lane.body.activeCampaignId, 'camp-A');
});

test('a campaign with a resend backlog is not judged failed', async () => {
  await seedCampaign('camp-A', { total: 70 });
  await post('/campaign-lane/claim', { campaignId: 'camp-A', total: 70 });
  await post('/campaign-lane/start', { campaignId: 'camp-A' });
  await recordSettled('camp-A', { sent: 30 });
  await getLane('camp-A');

  // Work is waiting to be re-sent, so there IS something left that can settle.
  await redis.rpush('resend:camp-A', JSON.stringify({ email: 'r1@example.com' }));

  const longAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  await redis.hset(campaignQueue.slotKey('camp-A'), 'lastProgressAt', longAgo, 'lastSettled', '30');

  const lane = await getLane('camp-A');
  assert.equal(lane.body.reconciled, null, 'a resumable backlog is not a failure');
});

/* ================================================================== *
 * Leaving the queue, and recovery.
 * ================================================================== */

test('a waiting campaign can leave the queue and the rest move up', async () => {
  for (const id of ['camp-A', 'camp-B', 'camp-C']) await seedCampaign(id, { total: 10 });

  await post('/campaign-lane/claim', { campaignId: 'camp-A', total: 10 });
  await post('/campaign-lane/start', { campaignId: 'camp-A' });
  await post('/campaign-lane/claim', { campaignId: 'camp-B', total: 10 });
  await post('/campaign-lane/claim', { campaignId: 'camp-C', total: 10 });

  const left = await post('/campaign-lane/leave', { campaignId: 'camp-B' });

  assert.equal(left.status, 200);
  assert.deepEqual(left.body.waiting, ['camp-C'], 'C moves up');
  assert.equal(left.body.activeCampaignId, 'camp-A', 'A keeps the lane');
});

test('a sending campaign cannot leave the queue — that is what Stop Sending is for', async () => {
  await seedCampaign('camp-A', { total: 70 });
  await post('/campaign-lane/claim', { campaignId: 'camp-A', total: 70 });
  await post('/campaign-lane/start', { campaignId: 'camp-A' });

  const refused = await post('/campaign-lane/leave', { campaignId: 'camp-A' });

  assert.equal(refused.status, 409);
  assert.match(refused.body.reason, /Stop Sending/);
  assert.equal(await campaignQueue.readActive(redis, USER), 'camp-A', 'still sending');
});

test('polling recovers the current view after a dropped connection', async () => {
  await seedCampaign('camp-A', { total: 70 });
  await seedCampaign('camp-B', { total: 30 });

  await post('/campaign-lane/claim', { campaignId: 'camp-A', total: 70 });
  await post('/campaign-lane/start', { campaignId: 'camp-A' });
  await post('/campaign-lane/claim', { campaignId: 'camp-B', total: 30 });

  // Simulates a tab that missed several polls: the lane is server-side, so the next
  // successful poll is authoritative regardless of how many were lost.
  await recordSettled('camp-A', { sent: 70 });

  const resumed = await getLane('camp-B');
  assert.equal(resumed.body.cleared, true, 'the wait resolves on the first poll that lands');
  assert.equal(resumed.body.activeCampaignId, 'camp-B');
});

test('the lane view is readable without naming a campaign', async () => {
  await seedCampaign('camp-A', { total: 70 });
  await post('/campaign-lane/claim', { campaignId: 'camp-A', total: 70 });

  const lane = await getLane(null);

  assert.equal(lane.status, 200);
  assert.equal(lane.body.activeCampaignId, 'camp-A');
  assert.equal(lane.body.campaignId, null);
  assert.equal(lane.body.cleared, false, 'no campaign named, so nothing is cleared');
});

/* ================================================================== *
 * Input handling.
 * ================================================================== */

test('claim and start require a campaignId', async () => {
  assert.equal((await post('/campaign-lane/claim', {})).status, 400);
  assert.equal((await post('/campaign-lane/start', {})).status, 400);
  assert.equal((await post('/campaign-lane/leave', {})).status, 400);
});

test('starting a campaign that never claimed the lane is refused', async () => {
  const denied = await post('/campaign-lane/start', { campaignId: 'never-claimed' });

  assert.equal(denied.status, 409);
  assert.equal(denied.body.code, 'DENIED');
});
