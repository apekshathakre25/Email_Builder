import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { SEND_FIELD_NAMES, sendEmail, stopSending } from '../../api/campaignApi';
import { ApiError } from '../../lib/apiClient';
import { keys } from '../../lib/queryKeys';
import { parseFileIds, parseTestRecipients, validateCampaignForm } from './campaignValidation';

/**
 * Submitting and stopping a campaign.
 *
 * ── Two principles run through everything here ───────────────────────────────
 *
 * 1. A rejected submission is not a failed campaign. Anything already queued keeps
 *    sending; only this batch was refused. Reporting "Send failed" for a 429 is what
 *    led operators to believe a running campaign had died and to start stopping and
 *    restarting healthy campaigns.
 *
 * 2. A stop changes the UI only once the server confirms it. The request goes first and
 *    the display follows. A UI that goes quiet on click and only then asks the server
 *    to stop teaches the operator to trust the screen over the mail server — which is
 *    precisely the failure a stop button must not have.
 */

/** Bounds for the automatic retry after a 429, in seconds. */
const RETRY_MIN_SECONDS = 2;
const RETRY_MAX_SECONDS = 60;

export function useCampaignSend({ form, bounds, onNotice, onStatusRefresh, lane }) {
  const queryClient = useQueryClient();

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [sessionId, setSessionId] = useState(null);
  const [lastBatch, setLastBatch] = useState(null);
  const [lastTestIds, setLastTestIds] = useState([]);
  const [validationError, setValidationError] = useState(null);

  /**
   * Handle for the retry scheduled after a 429.
   *
   * Kept so it can be cancelled. Without this, stopping a campaign that had just been
   * rate-limited would look stopped for a few seconds and then restart itself, because
   * the retry fires on a timer that knows nothing about the stop.
   */
  const retryTimer = useRef(null);

  /**
   * Indirection so the 429 retry can re-enter `performSend`.
   *
   * A useCallback cannot reference its own binding, so the retry calls through a ref that
   * an effect keeps pointing at the current closure.
   */
  const performSendRef = useRef(null);

  /**
   * Whether the campaign being watched has been stopped.
   *
   * A ref as well as being derivable from /status, because the retry timer needs to
   * consult it at the moment it fires, outside React's render cycle.
   */
  const stoppedRef = useRef(false);

  const notice = useCallback((message) => onNotice?.(message), [onNotice]);

  const cancelRetry = useCallback(() => {
    if (retryTimer.current) {
      clearTimeout(retryTimer.current);
      retryTimer.current = null;
    }
  }, []);

  useEffect(() => cancelRetry, [cancelRetry]);

  /** Marks the campaign stopped locally, so a pending retry cannot resurrect it. */
  const markStopped = useCallback(
    (stopped) => {
      stoppedRef.current = stopped;
      if (stopped) cancelRetry();
    },
    [cancelRetry]
  );

  /**
   * Builds the request body.
   *
   * Field names come from SEND_FIELD_NAMES because they are kebab-case HTML input
   * names, and a mismatch fails silently: the server reads undefined and produces a
   * connection error rather than a validation error naming the field.
   */
  const buildPayload = useCallback((currentForm, campaignSessionId) => {
    const isTest = currentForm.testBulk === 'Test';

    const payload = {
      [SEND_FIELD_NAMES.smtpHost]: currentForm.smtpHost,
      [SEND_FIELD_NAMES.smtpPort]: currentForm.smtpPort,
      [SEND_FIELD_NAMES.smtpUser]: currentForm.smtpUser,
      // Empty is meaningful: it asks the server to use the password stored for this
      // operator. See resolveSmtpPass in backend/routes/sendemails.js.
      [SEND_FIELD_NAMES.smtpPass]: currentForm.smtpPass,
      [SEND_FIELD_NAMES.mode]: currentForm.testBulk,
      [SEND_FIELD_NAMES.testRecipients]: currentForm.testRecipients,
      [SEND_FIELD_NAMES.limit]: currentForm.limit,
      [SEND_FIELD_NAMES.intervalSeconds]: currentForm.intervalSeconds,
      [SEND_FIELD_NAMES.fromName]: currentForm.fromName,
      [SEND_FIELD_NAMES.fromEmail]: currentForm.fromEmail,
      [SEND_FIELD_NAMES.subject]: currentForm.subject,
      [SEND_FIELD_NAMES.customHeaders]: currentForm.customHeaders,
      [SEND_FIELD_NAMES.customMessageId]: currentForm.customMessageId,
      [SEND_FIELD_NAMES.inboxPatternId]: currentForm.inboxPatternId,
      [SEND_FIELD_NAMES.messageType]: currentForm.messageType,
      [SEND_FIELD_NAMES.message]: currentForm.message,
      [SEND_FIELD_NAMES.fileIds]: currentForm.fileIds,
      [SEND_FIELD_NAMES.limitToSend]: currentForm.limitToSend,
      [SEND_FIELD_NAMES.sessionId]: campaignSessionId
    };

    // Only sent when on, and only for a test send. The server reads 'on'/'true'.
    if (isTest && currentForm.autoImapTest) {
      payload[SEND_FIELD_NAMES.autoImapTest] = 'on';
    }

    return payload;
  }, []);

  /**
   * Performs one submission.
   *
   * Separated from `submit` so the 429 retry can re-enter it without re-running
   * validation or re-queuing in the campaign lane — the place in the queue has already
   * been earned, and re-claiming it would send this tab to the back.
   */
  const performSend = useCallback(
    async (currentForm, campaignSessionId) => {
      setIsSubmitting(true);

      try {
        const data = await sendEmail(buildPayload(currentForm, campaignSessionId));

        setLastBatch({ batchCount: data?.batchCount ?? 0, limit: Number(currentForm.limit) || 0 });
        setLastTestIds(Array.isArray(data?.testIds) ? data.testIds : []);

        lane?.markSubmitted?.();
        markStopped(false);

        notice(
          `✅ Batch accepted — ${(data?.batchCount ?? 0).toLocaleString()} recipient${
            data?.batchCount === 1 ? '' : 's'
          } queued.`
        );

        // The files list shows per-file sent/pending counts that this submission will
        // start moving.
        queryClient.invalidateQueries({ queryKey: keys.files.all });

        onStatusRefresh?.(campaignSessionId);

        // The session id is returned rather than only stored in state: the caller needs it
        // immediately, and reading `sessionId` back after awaiting would give the value
        // from before this submission because the closure captured the previous render.
        return { ok: true, data, sessionId: campaignSessionId };
      } catch (err) {
        if (!(err instanceof ApiError)) {
          notice(`⚠️ Unexpected error while submitting (${err.message}).`);
          return { ok: false, error: err, sessionId: campaignSessionId };
        }

        if (err.isRateLimited) {
          const waitSeconds = Math.min(
            RETRY_MAX_SECONDS,
            Math.max(RETRY_MIN_SECONDS, err.retryAfterSeconds || 10)
          );

          notice(
            `⏳ ${err.message} Retrying in ${waitSeconds}s. Emails already queued keep sending.`
          );

          // Retry once the window has rolled over, so a transient 429 does not require
          // the operator to notice and click again. The stop flag is re-checked when it
          // fires so this cannot resurrect a campaign stopped in the meantime — which
          // would otherwise look like the stop had silently failed.
          cancelRetry();
          retryTimer.current = setTimeout(() => {
            retryTimer.current = null;
            if (stoppedRef.current) {
              notice('⏹️ Sending is stopped — the queued retry was cancelled.');
              return;
            }
            performSendRef.current?.(currentForm, campaignSessionId);
          }, waitSeconds * 1000);

          return { ok: false, error: err, willRetry: true, sessionId: campaignSessionId };
        }

        if (err.isUnauthorized) {
          notice('🔒 Your session expired. Please sign in again — queued emails keep sending.');
          return { ok: false, error: err, sessionId: campaignSessionId };
        }

        if (err.isNetworkError) {
          // The request may well have been accepted server-side, so this is explicitly
          // not reported as a failed campaign.
          notice(
            `⚠️ Could not confirm the request reached the server (${err.message}). ` +
              'Anything already queued keeps sending — check the counters before resubmitting.'
          );
          return { ok: false, error: err, sessionId: campaignSessionId };
        }

        notice(`❌ ${err.message}`);
        return { ok: false, error: err, sessionId: campaignSessionId };
      } finally {
        setIsSubmitting(false);
      }
    },
    [buildPayload, cancelRetry, lane, markStopped, notice, onStatusRefresh, queryClient]
  );

  useEffect(() => {
    performSendRef.current = performSend;
  }, [performSend]);

  /**
   * The Send Email action.
   *
   * Order matters: local validation first so a mistyped rate is reported immediately
   * rather than after a queue wait, then the lane, then the submission.
   */
  const submit = useCallback(
    async ({ onBeforeSubmit } = {}) => {
      setValidationError(null);

      // Commits any keystrokes still inside the autosave debounce window, and blanks a
      // password the browser filled in on its own.
      const prepared = onBeforeSubmit?.() ?? form;
      const currentForm = prepared ?? form;

      const validation = validateCampaignForm(currentForm, bounds);
      if (!validation.ok) {
        setValidationError(validation);
        notice(`❌ ${validation.error}`);
        return { ok: false, sessionId: null };
      }

      const isTest = currentForm.testBulk === 'Test';

      // Test sends get a fresh timestamped id every time — they are one-off placement
      // checks, not a resumable campaign. Bulk campaigns are identified by their first
      // file id, which is what makes a second click continue the same campaign.
      const campaignSessionId = isTest
        ? `test-${Date.now()}`
        : parseFileIds(currentForm.fileIds)[0];

      if (!campaignSessionId) {
        const error = 'Could not determine the campaign id. Check the File IDs field.';
        setValidationError({ ok: false, field: 'fileIds', error });
        notice(`❌ ${error}`);
        return { ok: false, sessionId: null };
      }

      const total = isTest ? parseTestRecipients(currentForm.testRecipients).length : 0;

      // One campaign per operator at a time. Waits for its turn and resolves true when
      // cleared, so a second tab holds here instead of sending alongside the first.
      const cleared = await lane?.requestSend?.({
        campaignId: isTest ? null : campaignSessionId,
        total,
        isTestMode: isTest,
        inboxPatternId: currentForm.inboxPatternId
      });

      if (cleared === false) return { ok: false, sessionId: campaignSessionId };

      setSessionId(campaignSessionId);
      cancelRetry();
      markStopped(false);

      return performSend(currentForm, campaignSessionId);
    },
    [bounds, cancelRetry, form, lane, markStopped, notice, performSend]
  );

  /**
   * The Stop Sending action.
   *
   * One implementation for every entry point — the button beside Send Email and the one
   * inside the interval popup. There is no separate "stop the interval": stopping the
   * interval is stopping the campaign.
   */
  const stop = useCallback(
    async (targetSessionId) => {
      const target = targetSessionId ?? sessionId;

      if (!target) {
        notice('⚠️ There is no campaign to stop yet.');
        return { ok: false };
      }

      // Cancelled before the request rather than after: a retry firing while the stop is
      // in flight would enqueue another batch.
      cancelRetry();

      setIsStopping(true);
      notice('⏳ Stopping — waiting for the server to confirm no more emails will be released…');

      try {
        const data = await stopSending(target);

        const tally =
          `${(data.sent ?? 0).toLocaleString()} sent, ` +
          `${(data.failed ?? 0).toLocaleString()} failed, ` +
          `${(data.pending ?? 0).toLocaleString()} still pending`;

        markStopped(true);

        notice(
          data.alreadyStopped
            ? `⏹️ This campaign was already stopped — ${tally}. Change Limit/Interval and click Send Email to continue.`
            : `⏹️ Sending stopped — ${tally}. Change Limit/Interval and click Send Email to continue.`
        );

        // One last read so the counters settle on whatever the in-flight sends finished
        // with, rather than freezing at the moment of the click.
        setTimeout(() => onStatusRefresh?.(target), 1_200);

        queryClient.invalidateQueries({ queryKey: keys.files.all });

        return { ok: true, data };
      } catch (err) {
        // The campaign is still running, so the UI must keep saying so.
        notice(
          err instanceof ApiError && err.isNetworkError
            ? `⚠️ Could not reach the server to stop the campaign (${err.message}). Sending may still be in progress — try again.`
            : `❌ Could not stop the campaign: ${err.message}. Sending is still in progress — try again.`
        );
        return { ok: false, error: err };
      } finally {
        setIsStopping(false);
      }
    },
    [cancelRetry, markStopped, notice, onStatusRefresh, queryClient, sessionId]
  );

  /** Adopts a campaign discovered on load, so a reload re-attaches the live view. */
  const adoptSession = useCallback((id) => {
    setSessionId((current) => current ?? id);
  }, []);

  return {
    sessionId,
    setSessionId,
    adoptSession,

    submit,
    isSubmitting,

    stop,
    isStopping,

    lastBatch,
    lastTestIds,
    validationError,
    clearValidationError: () => setValidationError(null),

    markStopped,
    cancelRetry
  };
}
