import { api } from '../lib/apiClient';

/**
 * The campaign lane: one campaign per operator at a time.
 *
 * Two tabs showing the same recipient file, a double-click, or a reloaded tab
 * deciding to submit again would otherwise each enqueue a copy. The server owns the
 * ordering; this app's job is to ask for a place, wait its turn, and claim the
 * one-shot start token before it is allowed to post /send-email.
 *
 * Two behaviours here are easy to get wrong and expensive when wrong:
 *
 *   - `pollLane` is the tab's heartbeat. A tab that stops polling is pruned as
 *     abandoned and loses its place.
 *
 *   - `pollLane` also drives the server's reconciler, which is the *only* thing
 *     that ever marks a campaign completed or failed and promotes the next one.
 *     Stop polling and campaigns stay 'in_progress' forever and the lane never
 *     drains. That is why the dashboard keeps polling the lane while it has a
 *     campaign, not only while it is waiting in the queue.
 */

/** Slot states, mirroring STATES in backend/utils/campaignQueue.js. */
export const LANE_STATES = Object.freeze({
  WAITING: 'WAITING',
  QUEUED: 'QUEUED',
  SENDING: 'SENDING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
  PAUSED: 'PAUSED'
});

/**
 * @typedef {Object} LaneView
 * @property {boolean} success
 * @property {string|null} campaignId
 * @property {string|null} state
 * @property {boolean} abandoned   Passed over because this tab stopped checking in,
 *   as opposed to being cancelled outright. The signal to re-claim rather than to
 *   report the campaign dead.
 * @property {number} position     0 when holding the lane or not queued at all.
 * @property {string|null} activeCampaignId
 * @property {string[]} waiting
 * @property {number} waitingCount
 * @property {boolean} cleared     The ONLY condition under which posting
 *   /send-email is permitted: this campaign holds the lane and has not started.
 */

/**
 * Joins the lane, or reports the place already held.
 *
 * Safe to call repeatedly, which is what lets a reloaded tab recover its position
 * instead of starting a second campaign or losing its turn.
 *
 * @returns {Promise<LaneView>}
 */
export function claimLane({ campaignId, total = 0 }) {
  return api.post('/campaign-lane/claim', { campaignId, total });
}

/**
 * The waiting poll, the heartbeat, and the completion reconciler, all in one call.
 *
 * @returns {Promise<LaneView & {reconciled: string|null, prunedCampaignIds: string[]}>}
 */
export function pollLane(campaignId, signal) {
  return api.get('/campaign-lane', { query: { campaignId }, signal });
}

/**
 * Claims the right to submit, exactly once.
 *
 * Must return `success: true` before /send-email. A 409 carries `code`
 * ('DENIED' | 'ALREADY') and a `reason`, and means do not submit — the ApiError
 * thrown by the client holds both.
 *
 * @returns {Promise<LaneView & {success: true}>}
 */
export function startLane(campaignId, inboxPatternId = '') {
  return api.post('/campaign-lane/start', {
    campaignId,
    ...(inboxPatternId ? { inboxPatternId } : {})
  });
}

/**
 * Gives up a place without sending.
 *
 * For an operator who changes their mind while queued. Refuses with 409 for a
 * campaign that is already SENDING — that is what stopSending is for, and routing a
 * live campaign through here would release the lane without the queue purge, the
 * resend backlog or the stop marker the rest of the system depends on.
 */
export function leaveLane(campaignId, { keepalive = false } = {}) {
  if (keepalive) {
    return fetch(`${import.meta.env.VITE_API_BASE_URL ?? ''}/campaign-lane/leave`, {
      method: 'POST',
      credentials: 'include',
      keepalive: true,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-Requested-With': 'XMLHttpRequest'
      },
      body: JSON.stringify({ campaignId })
    });
  }

  return api.post('/campaign-lane/leave', { campaignId });
}
