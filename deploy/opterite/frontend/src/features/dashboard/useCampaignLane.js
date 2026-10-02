import { useCallback, useEffect, useRef, useState } from 'react';

import * as laneApi from '../../api/laneApi';
import { LANE_STATES } from '../../api/laneApi';
import { ApiError } from '../../lib/apiClient';

/**
 * Campaign sequencing: one campaign per operator at a time.
 *
 * ── The problem ──────────────────────────────────────────────────────────────
 *
 * Nothing stops an operator opening two tabs on the same recipient file and pressing
 * Send in both, and nothing stops a reloaded tab deciding to submit again. Each would
 * enqueue its own copy of the batch and every recipient would be mailed twice.
 *
 * ── How it is solved ─────────────────────────────────────────────────────────
 *
 * The server owns the ordering. A tab claims a place, waits its turn, and must obtain a
 * one-shot start token before it is allowed to post /send-email. The interesting
 * details, all of which this hook has to respect:
 *
 *   - The GET poll *is* the heartbeat. A tab that stops polling is pruned as abandoned
 *     and loses its place.
 *
 *   - The same poll drives the server's reconciler, which is the only thing that ever
 *     marks a campaign completed or failed and promotes the next one. So polling
 *     continues while a campaign is sending, not merely while waiting in the queue —
 *     stop early and campaigns stay 'in_progress' forever and the lane never drains.
 *
 *   - There is deliberately no leave-beacon on pagehide. A refresh and a close are
 *     indistinguishable there, so a beacon would make every reload surrender the
 *     operator's place. Liveness is the heartbeat instead.
 *
 * ── Fail-open ────────────────────────────────────────────────────────────────
 *
 * If the lane endpoints cannot be reached, sending is allowed. Sequencing is a
 * convenience; a queue that cannot be consulted must not become the reason a campaign
 * cannot go out.
 */

const POLL_MS = 2_000;
const RETRY_MS = 5_000;
const MAX_CONSECUTIVE_ERRORS = 60;

/** Marker that survives a reload, so a returning tab knows it was mid-queue. */
const WAITING_MARKER_KEY = 'opterite:lane-waiting';

function readWaitingMarker() {
  try {
    return window.sessionStorage.getItem(WAITING_MARKER_KEY);
  } catch {
    return null;
  }
}

function writeWaitingMarker(campaignId) {
  try {
    if (campaignId) window.sessionStorage.setItem(WAITING_MARKER_KEY, campaignId);
    else window.sessionStorage.removeItem(WAITING_MARKER_KEY);
  } catch {
    /* storage unavailable; the queue still works, only reload recovery is lost */
  }
}

/**
 * @param {object} options
 * @param {(message: string) => void} options.onNotice Progress messages for the UI.
 */
export function useCampaignLane({ onNotice } = {}) {
  const [lane, setLane] = useState(null);
  const [isWaiting, setIsWaiting] = useState(false);

  const pollTimer = useRef(null);
  const errorCount = useRef(0);

  /**
   * Whether this tab's own submission is what put the lane into SENDING.
   *
   * Without it, a continuation batch — the second click of an unpaced campaign, or the
   * automatic retry after a 429 — would be refused as "already sending in another tab",
   * by this tab, about itself.
   */
  const ownedSending = useRef(false);

  /** One re-claim per abandonment, so a pruned tab cannot loop re-claiming. */
  const reclaimed = useRef(false);

  const waitingResolvers = useRef([]);
  const activeCampaignRef = useRef(null);

  /**
   * Indirection so `pollOnce` can schedule itself.
   *
   * A `useCallback` cannot reference its own binding — it is not initialised while its
   * body is being defined — so the recursion goes through a ref that an effect keeps
   * pointing at the current closure.
   */
  const pollOnceRef = useRef(null);

  const notice = useCallback(
    (message) => {
      if (message) onNotice?.(message);
    },
    [onNotice]
  );

  const stopPolling = useCallback(() => {
    if (pollTimer.current) {
      clearTimeout(pollTimer.current);
      pollTimer.current = null;
    }
  }, []);

  /** Releases everyone awaiting a verdict on the current wait. */
  const settleWaiters = useCallback((cleared) => {
    const resolvers = waitingResolvers.current;
    waitingResolvers.current = [];
    for (const resolve of resolvers) resolve(cleared);
  }, []);

  const stopWaiting = useCallback(
    (cleared) => {
      stopPolling();
      setIsWaiting(false);
      writeWaitingMarker(null);
      settleWaiters(cleared);
    },
    [stopPolling, settleWaiters]
  );

  useEffect(() => stopPolling, [stopPolling]);

  /**
   * One poll, plus the decision it implies.
   *
   * Returns the lane view so callers can act on it, and schedules the next poll unless
   * the wait has ended.
   */
  const pollOnce = useCallback(
    async (campaignId, { schedule = true } = {}) => {
      if (!campaignId) return null;

      let view;
      try {
        view = await laneApi.pollLane(campaignId);
        if (errorCount.current > 0) {
          notice('✅ Reconnected to the campaign queue…');
          errorCount.current = 0;
        }
      } catch (err) {
        errorCount.current += 1;

        if (errorCount.current >= MAX_CONSECUTIVE_ERRORS) {
          notice(
            '⚠️ Could not reach the server to check the campaign queue. Press Send Email to try again.'
          );
          stopWaiting(false);
          return null;
        }

        notice(`⏳ Reconnecting to the campaign queue… (attempt ${errorCount.current})`);

        if (schedule && isWaiting) {
          pollTimer.current = setTimeout(() => pollOnceRef.current?.(campaignId), RETRY_MS);
        }
        return null;
      }

      setLane(view);

      if (view.cleared) {
        notice('▶️ Starting campaign…');
        stopWaiting(true);
        return view;
      }

      // Dropped for missing heartbeats rather than cancelled outright. The tab is
      // demonstrably still here, so re-claim its place once instead of reporting the
      // campaign dead.
      if (view.state === LANE_STATES.CANCELLED && view.abandoned && !reclaimed.current) {
        reclaimed.current = true;
        try {
          const reclaimedView = await laneApi.claimLane({ campaignId });
          setLane(reclaimedView);
          if (reclaimedView.cleared) {
            stopWaiting(true);
            return reclaimedView;
          }
        } catch {
          /* the next poll will report the state */
        }
      } else if (view.state === LANE_STATES.CANCELLED && !view.abandoned) {
        notice('⚠️ This campaign is no longer queued. Press Send Email to queue it again.');
        stopWaiting(false);
        return view;
      }

      // Limit to Send paused the campaign. That is a fresh claim rather than a
      // continuation, so this tab's ownership of the SENDING state no longer applies.
      if (view.state === LANE_STATES.PAUSED) ownedSending.current = false;

      if (view.state === LANE_STATES.WAITING || view.state === LANE_STATES.QUEUED) {
        const ahead = Math.max(0, view.position - 1);
        notice(
          ahead > 0
            ? `⏳ Waiting for the previous campaign to complete… ${ahead} campaign${ahead === 1 ? '' : 's'} ahead of this one.`
            : '⏳ Waiting for the previous campaign to complete…'
        );
      }

      if (schedule && isWaiting) {
        pollTimer.current = setTimeout(() => pollOnceRef.current?.(campaignId), POLL_MS);
      }

      return view;
    },
    [isWaiting, notice, stopWaiting]
  );

  useEffect(() => {
    pollOnceRef.current = pollOnce;
  }, [pollOnce]);

  /**
   * Asks for permission to submit, waiting for a turn if necessary.
   *
   * Resolves true when this tab may post /send-email, false when it must not.
   *
   * Resolves true immediately for a test send: a handful of inbox-placement addresses
   * is not a campaign and does not need a lane. Also resolves true when the lane
   * cannot be reached at all — see the fail-open note above.
   *
   * @param {{campaignId: string|null, total?: number, isTestMode?: boolean,
   *   inboxPatternId?: string}} params
   * @returns {Promise<boolean>}
   */
  const requestSend = useCallback(
    async ({ campaignId, total = 0, isTestMode = false, inboxPatternId = '' }) => {
      if (isTestMode || !campaignId) return true;

      activeCampaignRef.current = campaignId;
      errorCount.current = 0;
      reclaimed.current = false;

      let view;
      try {
        view = await laneApi.claimLane({ campaignId, total });
        setLane(view);
      } catch {
        // Fail open. A queue that cannot be consulted must not block sending.
        notice('⚠️ Could not reach the campaign queue — sending without sequencing.');
        return true;
      }

      // Already sending. Permitted only when this tab is the one that started it: a
      // continuation batch or a 429 retry. Otherwise another tab owns the campaign.
      if (view.state === LANE_STATES.SENDING) {
        if (ownedSending.current) return claimStartToken(campaignId, inboxPatternId, notice);
        notice('⚠️ This campaign is already sending in another tab.');
        return false;
      }

      if (view.cleared) return claimStartToken(campaignId, inboxPatternId, notice);

      // Queued behind something. Wait, polling as the heartbeat, and resolve when the
      // server clears this campaign.
      writeWaitingMarker(campaignId);
      setIsWaiting(true);

      const cleared = await new Promise((resolve) => {
        waitingResolvers.current.push(resolve);
        pollOnce(campaignId);
      });

      if (!cleared) return false;

      return claimStartToken(campaignId, inboxPatternId, notice);
    },
    [notice, pollOnce]
  );

  /**
   * Confirms to the lane that the submission landed.
   *
   * Makes a later batch of the same campaign from this tab recognisable as a
   * continuation rather than as a second tab trying to start it.
   */
  const markSubmitted = useCallback(() => {
    ownedSending.current = true;
    writeWaitingMarker(null);
  }, []);

  /** Gives up a queued place. Refused by the server for a campaign already sending. */
  const cancelWait = useCallback(
    async (campaignId) => {
      const target = campaignId ?? activeCampaignRef.current;
      stopWaiting(false);
      if (!target) return;

      try {
        await laneApi.leaveLane(target);
        notice('ℹ️ Left the campaign queue.');
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          notice('⚠️ This campaign is already sending. Use Stop Sending to halt it.');
          return;
        }
        notice(`⚠️ Could not leave the campaign queue (${err.message}).`);
      }
    },
    [notice, stopWaiting]
  );

  /**
   * Keeps the heartbeat and the reconciler running for a campaign this tab is
   * watching, even when not queued behind anything.
   *
   * This is what makes campaigns reach a terminal state. GET /campaign-lane is the only
   * caller of the server's reconciler, so without a poll while sending, a finished
   * campaign is never marked completed and the lane is never released for the next one.
   */
  const keepAlive = useCallback(
    (campaignId) => {
      if (!campaignId || isWaiting) return undefined;

      let cancelled = false;
      let timer = null;

      const tick = async () => {
        if (cancelled) return;
        try {
          const view = await laneApi.pollLane(campaignId);
          if (!cancelled) setLane(view);
        } catch {
          /* transient; the next tick tries again */
        }
        if (!cancelled) timer = setTimeout(tick, POLL_MS);
      };

      tick();

      return () => {
        cancelled = true;
        if (timer) clearTimeout(timer);
      };
    },
    [isWaiting]
  );

  /**
   * Recovers a wait interrupted by a reload.
   *
   * Only acts when the stored marker names the campaign currently in the form, so a tab
   * reloaded onto a different file does not adopt somebody else's place in the queue.
   *
   * @returns {Promise<boolean>} true when the campaign is now cleared to send, which
   *   the dashboard uses to resubmit automatically — the operator already pressed Send.
   */
  const resumeAfterReload = useCallback(
    async (campaignId) => {
      if (!campaignId) return false;
      if (readWaitingMarker() !== campaignId) return false;

      try {
        const view = await laneApi.claimLane({ campaignId });
        setLane(view);

        if (view.cleared) {
          writeWaitingMarker(null);
          return true;
        }

        setIsWaiting(true);
        const cleared = await new Promise((resolve) => {
          waitingResolvers.current.push(resolve);
          pollOnce(campaignId);
        });
        return cleared;
      } catch {
        writeWaitingMarker(null);
        return false;
      }
    },
    [pollOnce]
  );

  return {
    lane,
    isWaiting,
    waitingAhead: Math.max(0, (lane?.position ?? 0) - 1),
    requestSend,
    markSubmitted,
    cancelWait,
    keepAlive,
    resumeAfterReload
  };
}

/**
 * Takes the one-shot start token.
 *
 * Must succeed before /send-email. A 409 means another tab, a double click or a
 * finished campaign got there first, and the answer is not to submit.
 */
async function claimStartToken(campaignId, inboxPatternId, notice) {
  try {
    await laneApi.startLane(campaignId, inboxPatternId);
    return true;
  } catch (err) {
    if (err instanceof ApiError) {
      if (err.status === 409) {
        notice(`⚠️ ${err.payload?.reason ?? 'Another campaign started first.'}`);
        return false;
      }
      // Anything else is infrastructure rather than a refusal. Fail open, consistent
      // with the rest of this hook.
      notice('⚠️ Could not confirm the campaign queue — sending anyway.');
      return true;
    }
    return true;
  }
}
