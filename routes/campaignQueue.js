/**
 * Endpoints for running one operator's campaigns one after another.
 *
 * The lane mechanics live in utils/campaignQueue.js; this is the part that knows what
 * "finished" means, because that has to agree with what /status already tells the
 * browser. It reuses readCampaignProgress from routes/sendemails rather than
 * recomputing it.
 *
 * WHERE COMPLETION IS DECIDED. Reconciliation is lazy: every poll of
 * GET /campaign-lane re-evaluates whoever holds the lane before answering. There is
 * no new scheduler, and none is needed — if no tab is waiting then nobody is blocked,
 * and the lane claim's own TTL clears an abandoned hold. This also means the decision
 * is made by a web process reading Redis and MongoDB, so it is correct whether or not
 * the tab that started the campaign is still open.
 *
 * WHY NOT THE WORKER. A worker handling one job has no idea whether it is recipient 1
 * or recipient 1,000,000 — the payload carries no index or total — and there is no
 * end-of-campaign hook on the queue. Any completion check has to compare settled
 * against total, which is a campaign-level read. Doing it here keeps the workers'
 * hot path untouched.
 */

const express = require('express');
const router = express.Router();

const logger = require('../utils/logger');
const { getSharedRedisClient } = require('../config/redis');
const campaignQueue = require('../utils/campaignQueue');
const { STATES } = campaignQueue;
const { readCampaignProgress, markCampaignTerminal } = require('./sendemails');

const redisClient = getSharedRedisClient();

/**
 * How long a SENDING campaign may show no newly settled recipients before it is
 * treated as failed rather than slow.
 *
 * Only ever consulted once a campaign has nothing left in flight and an empty resend
 * backlog, so a healthy campaign waiting on a rate-limit interval can never trip it.
 * The floor is generous because SMTP timeouts, Bull's three attempts with
 * exponential backoff, and a paced campaign's interval all legitimately produce long
 * gaps; the interval is added on top for exactly that reason.
 */
const STALL_FLOOR_MS = 2 * 60 * 1000;

function stallWindowMs(progress) {
  const interval = Math.max(0, Number(progress.rateIntervalSeconds) || 0) * 1000;
  return STALL_FLOOR_MS + interval * 3;
}

/**
 * Decides whether the campaign holding the lane is done, and frees it if so.
 *
 * Returns the terminal state it applied, or null if the campaign is still running.
 * Order matters: a stop is checked first because it is the operator's explicit
 * instruction and outranks any arithmetic about counts.
 */
async function reconcileActive(userId) {
  const activeId = await campaignQueue.readActive(redisClient, userId);
  if (!activeId) return null;

  const slot = await campaignQueue.readSlot(redisClient, activeId);

  // Cleared to start but not yet submitted. Normally that is just the gap between a
  // tab being told "go" and it posting /send-email, so there is nothing to reconcile.
  //
  // Unless its tab has stopped checking in. A campaign promoted moments before its tab
  // closed would otherwise hold the lane in QUEUED forever — nothing here would ever
  // release it, and everything behind it would wait for the claim's six-hour expiry.
  // It is passed over rather than started: nobody is watching it.
  if (slot && slot.state === STATES.QUEUED) {
    if (!campaignQueue.isStale(slot)) return null;

    const { promotedCampaignId } = await campaignQueue.release(redisClient, {
      userId, campaignId: activeId, state: STATES.CANCELLED
    });
    logger.info(
      `🚪 Campaign lane: ${activeId} was cleared to send but its tab has gone — ` +
      'cancelled without sending' +
      (promotedCampaignId ? `, ${promotedCampaignId} promoted.` : '.')
    );
    return STATES.CANCELLED;
  }

  let progress;
  try {
    progress = await readCampaignProgress(activeId);
  } catch (err) {
    // A read failure must not release the lane — that would let the next campaign
    // start alongside one that is probably still sending.
    logger.warn(`⚠️  Campaign lane: could not read progress for ${activeId}: ${err.message}`);
    return null;
  }

  // 1. Stopped by the operator. Terminal for this run, but the campaign keeps its
  //    pending recipients and can be resubmitted later, which is the existing stop
  //    contract (utils/campaignStop.js). The lane must free either way, or stopping
  //    one campaign would deadlock every campaign behind it.
  if (progress.stopped) {
    const { promotedCampaignId } = await campaignQueue.release(redisClient, {
      userId, campaignId: activeId, state: STATES.CANCELLED
    });
    logger.info(
      `⏹️  Campaign lane: ${activeId} was stopped, lane released` +
      (promotedCampaignId ? `, ${promotedCampaignId} promoted.` : '.')
    );
    return STATES.CANCELLED;
  }

  // 2. Every recipient settled. This is also the only place the durable record is
  //    finally marked completed.
  if (progress.finished) {
    await markCampaignTerminal(activeId, 'completed');
    const { promotedCampaignId } = await campaignQueue.release(redisClient, {
      userId, campaignId: activeId, state: STATES.COMPLETED
    });
    logger.force(
      `✅ Campaign lane: ${activeId} completed ${progress.settled}/${progress.total}` +
      (promotedCampaignId ? ` — ${promotedCampaignId} promoted.` : ' — lane empty.')
    );
    return STATES.COMPLETED;
  }

  // 3. The per-action cap was reached: everything this Send Email action released has
  //    settled, but the campaign still has entries left.
  //
  //    Checked BEFORE the stall logic below, which would otherwise call this a failure —
  //    nothing is settling and `total - settled` is non-zero, which is exactly what a
  //    stalled campaign looks like from the outside. The difference is the watermark:
  //    a paused campaign has settled everything it *released* (`settled >= sentIndex`),
  //    whereas a stalled one has released work that never came back.
  //
  //    The lane is freed so a campaign waiting in another tab can run, but the durable
  //    record is deliberately left `in_progress`: this campaign is not finished, and
  //    it must not restart on its own — only another manual click sends the next batch.
  if (
    progress.sentIndex > 0 &&
    progress.settled >= progress.sentIndex &&
    progress.settled < progress.total &&
    progress.resendQueued === 0
  ) {
    const { promotedCampaignId } = await campaignQueue.release(redisClient, {
      userId, campaignId: activeId, state: STATES.PAUSED
    });
    logger.force(
      `⏸️  Campaign lane: ${activeId} reached its Limit to Send at ` +
      `${progress.settled}/${progress.total} — paused, ${progress.total - progress.settled} ` +
      'still pending for the next Send Email' +
      (promotedCampaignId ? `. ${promotedCampaignId} promoted.` : '.')
    );
    return STATES.PAUSED;
  }

  // 4. Still moving. Record it so a later poll can tell slow from stalled.
  const lastSettled = slot ? slot.lastSettled : 0;
  const lastProgressAt = slot && slot.lastProgressAt ? Date.parse(slot.lastProgressAt) : Date.now();

  if (progress.settled > lastSettled || !slot) {
    await campaignQueue.noteProgress(redisClient, {
      userId, campaignId: activeId, settled: progress.settled
    });
    return null;
  }

  // 5. Nothing settled since last time. Only a failure if there is also nothing
  //    left that could settle: no jobs in flight and no backlog waiting for the
  //    next submission. Otherwise it is simply slow, and the claim is refreshed.
  //
  //    Measured against the watermark, not the total. `total - settled` counts entries
  //    this action never released, which a campaign capped by Limit to Send always has;
  //    using it here is what made a paused campaign look like a stalled one.
  const inFlight = Math.max(0, progress.sentIndex - progress.settled - progress.resendQueued);
  const stalledFor = Date.now() - lastProgressAt;

  if (progress.resendQueued > 0 || inFlight === 0 || stalledFor < stallWindowMs(progress)) {
    await campaignQueue.touchActive(redisClient, userId);
    return null;
  }

  // Deliberately NOT marked completed — it did not reach its recipients. The
  // durable record moves to 'failed' so the campaign is distinguishable from one
  // that finished, and the next campaign is released so the operator is not stuck.
  await markCampaignTerminal(activeId, 'failed');
  const { promotedCampaignId } = await campaignQueue.release(redisClient, {
    userId, campaignId: activeId, state: STATES.FAILED
  });
  logger.force(
    `⚠️  Campaign lane: ${activeId} made no progress for ${Math.round(stalledFor / 1000)}s ` +
    `at ${progress.settled}/${progress.total} with nothing in flight — marked failed` +
    (promotedCampaignId ? `, ${promotedCampaignId} promoted.` : '.')
  );
  return STATES.FAILED;
}

/** The lane view one tab needs: its own state, and what is ahead of it. */
async function describe(userId, campaignId) {
  const [activeId, lane, slot] = await Promise.all([
    campaignQueue.readActive(redisClient, userId),
    campaignQueue.readLane(redisClient, userId),
    campaignId ? campaignQueue.readSlot(redisClient, campaignId) : Promise.resolve(null)
  ]);

  const position = campaignId && activeId === campaignId
    ? 0
    : lane.indexOf(campaignId) + 1; // 0 when absent, which reads as "not queued"

  return {
    success: true,
    campaignId: campaignId || null,
    state: slot ? slot.state : null,
    // True when this campaign was passed over because its tab stopped checking in, as
    // opposed to being cancelled outright. A tab that is actually still there — merely
    // suspended, or slow to reload — uses this to re-claim its place rather than
    // reporting the campaign dead.
    abandoned: Boolean(slot && slot.abandoned),
    position,
    activeCampaignId: activeId,
    waiting: lane,
    waitingCount: lane.length,
    // True only when this campaign holds the lane and has not started yet, which is
    // the single condition the browser is allowed to submit on.
    cleared: Boolean(campaignId) && activeId === campaignId && slot !== null && slot.state === STATES.QUEUED
  };
}

/**
 * Joins the lane, or reports the place already held.
 *
 * Safe to call repeatedly. A tab that reloads calls this again on load and recovers
 * its state — WAITING keeps its position, SENDING is reported as already running —
 * rather than starting a second campaign or losing its turn.
 */
router.post('/campaign-lane/claim', async (req, res) => {
  try {
    const userId = req.user?.email;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const campaignId = String(req.body?.campaignId || '').trim();
    if (!campaignId) return res.status(400).json({ error: 'campaignId is required' });

    const total = Number(req.body?.total) || 0;

    // Drop tabs that have closed, then free the lane if its holder has already
    // finished, so a tab claiming into an idle-but-unreleased lane is cleared
    // immediately and is not told it is queued behind campaigns that no longer exist.
    await campaignQueue.pruneAbandonedWaiting(redisClient, userId);
    await reconcileActive(userId);

    const claimed = await campaignQueue.claim(redisClient, { userId, campaignId, total });
    const view = await describe(userId, campaignId);

    logger.info(
      `🎫 Campaign lane [${userId}]: ${campaignId} claimed -> ${claimed.state}` +
      (claimed.state === STATES.WAITING ? ` (position ${view.position})` : '')
    );

    res.json(view);
  } catch (err) {
    console.error('Error in /campaign-lane/claim:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * The poll a waiting tab runs. Reconciles the holder, then answers.
 *
 * This is what makes sequencing work without the previous tab being open: the
 * waiting tab's own poll is what notices the campaign ahead of it has finished.
 */
router.get('/campaign-lane', async (req, res) => {
  try {
    const userId = req.user?.email;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const campaignId = String(req.query?.campaignId || '').trim();

    // This poll IS the calling tab's heartbeat. Recorded before anything else so a tab
    // can never be pruned by the same request that proves it is alive.
    if (campaignId) await campaignQueue.heartbeat(redisClient, campaignId);

    // Then drop anyone who has stopped checking in, so the queue and the "N ahead of
    // you" count reflect tabs that are actually still open.
    const pruned = await campaignQueue.pruneAbandonedWaiting(redisClient, userId);
    if (pruned.length > 0) {
      logger.info(
        `🚪 Campaign lane [${userId}]: dropped ${pruned.length} waiting campaign(s) ` +
        `whose tabs have closed — ${pruned.join(', ')}. They will not send.`
      );
    }

    const applied = await reconcileActive(userId);
    const view = await describe(userId, campaignId || null);

    // `prunedCampaignIds` is what this request dropped; `abandoned` (from describe) is
    // whether the campaign being asked about was itself dropped. Distinct questions.
    res.json({ ...view, reconciled: applied, prunedCampaignIds: pruned });
  } catch (err) {
    console.error('Error in GET /campaign-lane:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Claims the right to submit, exactly once.
 *
 * The browser must call this and receive ok:true before posting /send-email. Two
 * tabs showing the same recipient file, a double-click, or a reloaded tab deciding
 * to submit again all get ok:false here instead of enqueuing a second copy.
 */
router.post('/campaign-lane/start', async (req, res) => {
  try {
    const userId = req.user?.email;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const campaignId = String(req.body?.campaignId || '').trim();
    if (!campaignId) return res.status(400).json({ error: 'campaignId is required' });

    const result = await campaignQueue.markSending(redisClient, { userId, campaignId });

    // The lane view is spread FIRST so the outcome fields below win. describe()
    // carries its own `success: true`, and spreading it last silently turned every
    // refusal into a success the browser would have acted on.
    const view = await describe(userId, campaignId);

    if (!result.ok) {
      logger.info(`🚫 Campaign lane [${userId}]: ${campaignId} refused to start — ${result.reason}`);
      return res.status(409).json({
        ...view,
        success: false,
        code: result.code,
        reason: result.reason
      });
    }

    logger.force(`▶️  Campaign lane [${userId}]: ${campaignId} cleared to send.`);
    res.json({ ...view, success: true });
  } catch (err) {
    console.error('Error in /campaign-lane/start:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Gives up a place in the lane without sending.
 *
 * For a tab whose operator changes their mind while waiting. A campaign that is
 * already SENDING is not cancelled here — that is what /stop-sending is for, and
 * routing it through this endpoint would stop sending without the purge, the resend
 * backlog or the stop marker the rest of the system relies on.
 */
router.post('/campaign-lane/leave', async (req, res) => {
  try {
    const userId = req.user?.email;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const campaignId = String(req.body?.campaignId || '').trim();
    if (!campaignId) return res.status(400).json({ error: 'campaignId is required' });

    const slot = await campaignQueue.readSlot(redisClient, campaignId);
    if (slot && slot.state === STATES.SENDING) {
      return res.status(409).json({
        success: false,
        reason: 'This campaign is already sending. Use Stop Sending to halt it.'
      });
    }

    const { promotedCampaignId } = await campaignQueue.release(redisClient, {
      userId, campaignId, state: STATES.CANCELLED
    });

    res.json({ ...(await describe(userId, campaignId)), success: true, promotedCampaignId });
  } catch (err) {
    console.error('Error in /campaign-lane/leave:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

// Exported for tests, which drive the reconciler directly rather than through a poll.
module.exports.reconcileActive = reconcileActive;
module.exports.STALL_FLOOR_MS = STALL_FLOOR_MS;
