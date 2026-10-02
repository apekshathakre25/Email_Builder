import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { getCampaignStatus } from '../../api/campaignApi';
import { keys } from '../../lib/queryKeys';

/**
 * Polling cadence.
 *
 * 1.5s while work is in flight is deliberate and was arrived at the hard way. It used
 * to be 3s, because /status read its counts from MongoDB, which the worker's
 * BatchLogger only flushes on a 2000ms timer — polling faster re-read numbers that
 * could not have changed. /status now reports the worker's live per-email Redis tally,
 * so every poll carries fresh data and the interval is the whole of the visible
 * latency. That latency is what operators were reporting as the Sent count "updating
 * late".
 *
 * The bound is request budget, not data freshness: /status has its own 600/min bucket,
 * so one tab costs ~40/min and a dozen tabs still fit comfortably. The incident that
 * once made 3s look necessary — status polling starving POST /send-email — was a
 * *shared* bucket, and the dedicated limiter fixed it.
 */
const POLL_SENDING_MS = 1_500;
const POLL_IDLE_MS = 10_000;

/**
 * A hidden tab keeps polling, just rarely, so returning to it shows something recent
 * rather than a frozen panel. React Query refetches on focus, so the long interval
 * costs nothing perceptible.
 */
const POLL_HIDDEN_MS = 30_000;

/**
 * Watches one campaign.
 *
 * Deliberately adopts a campaign that is already running rather than only tracking one
 * this tab started. Polling used to begin only from the submit success path, which left
 * a live campaign with no poller after a reload: the counters froze and never moved
 * again. Operators reasonably read a frozen panel as a stalled campaign and installed a
 * browser extension to reload the page every few seconds — which restarted the same
 * dead end while consuming the rate-limit allowance campaign submission needed.
 *
 * @param {string|null} sessionId
 * @param {object} [options]
 * @param {boolean} [options.enabled=true]
 */
export function useCampaignStatus(sessionId, { enabled = true } = {}) {
  const queryClient = useQueryClient();

  // Mirrors document.hidden as state so the poll interval can depend on it. Reading
  // document.hidden inside refetchInterval would not re-evaluate on visibility change.
  const [isHidden, setIsHidden] = useState(() => (typeof document === 'undefined' ? false : document.hidden));

  useEffect(() => {
    const handler = () => setIsHidden(document.hidden);
    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
  }, []);

  const isActive = Boolean(enabled && sessionId);

  const query = useQuery({
    queryKey: keys.campaign.status(sessionId),
    queryFn: ({ signal }) => getCampaignStatus(sessionId, signal),
    enabled: isActive,

    // Always considered stale: a campaign's counters change continuously, and caching
    // them would mean showing an operator numbers from before their last action.
    staleTime: 0,

    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return POLL_IDLE_MS;

      // Terminal. Every recipient is accounted for, so there is nothing left to
      // observe — polling a finished campaign forever is pure waste.
      if (isTerminal(data)) return false;

      // A stop is terminal for this run: nothing changes until the operator submits
      // again, and the in-flight sends that were still settling have been given a
      // final read by the stop handler.
      if (data.stopped) return false;

      if (isHidden) return POLL_HIDDEN_MS;

      // `sending` is the server's own count of enqueued-but-unsettled work. Using it
      // avoids a first-poll bug the old client had: it tested
      // `(sent + failed) >= sentIndex`, trivially 0 >= 0 before the background enqueue
      // had advanced sentIndex, so every campaign immediately declared itself
      // not-sending and dropped to the slow interval.
      return (data.sending ?? 0) > 0 ? POLL_SENDING_MS : POLL_IDLE_MS;
    },

    // Keep polling in the background, at the hidden interval.
    refetchIntervalInBackground: true,

    // A single failed poll is transient. Leaving the last good data in place is what
    // stops a blip looking like a failed campaign.
    retry: 1,
    placeholderData: (previous) => previous
  });

  /**
   * One immediate read, outside the polling schedule.
   *
   * Used after a stop is confirmed so the counters settle on whatever the in-flight
   * sends actually finished with, instead of freezing at the instant of the click.
   */
  const refreshNow = useCallback(
    (targetSessionId = sessionId) => {
      if (!targetSessionId) return Promise.resolve(null);
      return queryClient.fetchQuery({
        queryKey: keys.campaign.status(targetSessionId),
        queryFn: ({ signal }) => getCampaignStatus(targetSessionId, signal)
      });
    },
    [queryClient, sessionId]
  );

  const status = query.data ?? null;

  /**
   * When this reading arrived.
   *
   * Exposed so the dashboard can decide whether the campaign line or a more recent
   * operator-facing message should be displayed, rather than having the two race to write
   * the same piece of state.
   */
  const updatedAt = query.dataUpdatedAt;

  const derived = useMemo(() => {
    if (!status) {
      return {
        settled: 0,
        isTerminal: false,
        isSending: false,
        isPaced: false,
        hasCampaign: false
      };
    }

    return {
      settled: (status.sent ?? 0) + (status.failed ?? 0),
      isTerminal: isTerminal(status),
      isSending: (status.sending ?? 0) > 0,
      // A null rateLimit is the server's signal that the campaign has no interval, and
      // therefore no interval UI to show.
      isPaced: Boolean(status.rateLimit?.limit && status.rateLimit?.intervalSeconds),
      hasCampaign: (status.total ?? 0) > 0 || (status.sentIndex ?? 0) > 0
    };
  }, [status]);

  return {
    status,
    updatedAt,
    ...derived,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    error: query.error,
    refreshNow
  };
}

/** Every recipient accounted for. */
function isTerminal(status) {
  const total = status.total ?? 0;
  const settled = (status.sent ?? 0) + (status.failed ?? 0);
  return total > 0 && settled >= total;
}

/**
 * Composes the campaign status line.
 *
 * The distinction this exists to preserve: a failed *recipient* is not a failed
 * *campaign*. `lastError` is appended as context on a campaign that is still running,
 * never substituted for the whole line — the old code replaced the entire message with
 * it, so one bad address looked identical to a dead campaign.
 */
export function describeCampaign(status) {
  if (!status) return '';

  const total = status.total ?? 0;
  const sent = status.sent ?? 0;
  const failed = status.failed ?? 0;
  const inFlight = status.sending ?? 0;
  const settled = sent + failed;
  const tally = `${sent.toLocaleString()} sent, ${failed.toLocaleString()} failed of ${total.toLocaleString()}`;

  if (status.stopped) {
    const pending = Math.max(0, total - settled);
    return (
      `⏹️ Sending stopped — ${tally}, ${pending.toLocaleString()} still pending. ` +
      'Change Limit/Interval and click Send Email to continue.'
    );
  }

  if (total > 0 && settled >= total) {
    return failed > 0
      ? `⚠️ Campaign finished — ${tally}. Some emails failed; download the log for details.`
      : `✅ Campaign complete — ${tally}.`;
  }

  let line =
    inFlight > 0
      ? `📤 Campaign is running — ${tally}, ${inFlight.toLocaleString()} in queue.`
      : `⏸️ Campaign is idle — ${tally}. Submit the next batch to continue.`;

  if (status.lastError) line += ` Most recent send error: ${status.lastError}`;

  return line;
}
