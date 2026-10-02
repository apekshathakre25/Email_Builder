import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { downloadLog } from '../../api/logsApi';
import { useAppConfig } from '../../providers/AppConfigProvider';
import { useConfirm } from '../../providers/ConfirmProvider';
import { useToast } from '../../providers/ToastProvider';
import { SystemHealthStrip } from '../health/SystemHealthStrip';
import { TestResultsPanel } from '../imap/TestResultsPanel';
import { useImapTesting } from '../imap/useImapTesting';

import { EmailConfigCard } from './components/EmailConfigCard';
import { HowToUseModal } from './components/HowToUseModal';
import { IntervalPopup } from './components/IntervalPopup';
import { BulkLiveStatus, ResultsLine, TestLiveStatus } from './components/LiveStatusPanel';
import { MessageIdHelpModal } from './components/MessageIdHelpModal';
import { MessagePreviewModal } from './components/MessagePreviewModal';
import { SmtpCredentialsCard } from './components/SmtpCredentialsCard';
import { parseFileIds, parseTestRecipients } from './campaignValidation';
import { useCampaignForm } from './useCampaignForm';
import { useCampaignLane } from './useCampaignLane';
import { useCampaignSend } from './useCampaignSend';
import { describeCampaign, useCampaignStatus } from './useCampaignStatus';

/**
 * The campaign console.
 *
 * Composition, so the moving parts are visible:
 *
 *   useCampaignForm    form state + per-tab draft + the server-side SMTP password
 *   useCampaignLane    one campaign per operator; the queue, heartbeat and reconciler
 *   useCampaignSend    submit, the 429 retry, and stop
 *   useCampaignStatus  progress polling at a cadence that follows the campaign
 *   useImapTesting     inbox-placement accounts, checks and results
 *
 * The orchestration left in this component is campaign adoption: on load, and whenever
 * File IDs changes, it asks the server whether that campaign is still running and
 * attaches the live view if so. Without it a reload left a live campaign with no poller —
 * the counters froze, operators read that as a stalled campaign, and the workaround was a
 * browser extension reloading the page every few seconds, which consumed the very
 * rate-limit allowance campaign submission needed.
 *
 * Several effects below read through a `latest` ref rather than depending on the hook
 * objects directly. Those objects are rebuilt every render, so depending on them would
 * re-run the effect on every render — harmless for an idempotent probe, but it makes the
 * dependency list a lie about when the effect is supposed to fire.
 */
export function DashboardPage() {
  const appConfig = useAppConfig();
  const toast = useToast();
  const confirm = useConfirm();

  const [showPreview, setShowPreview] = useState(false);
  const [showMessageIdHelp, setShowMessageIdHelp] = useState(false);
  const [showHowToUse, setShowHowToUse] = useState(false);
  const [showTestResults, setShowTestResults] = useState(false);

  /** Which campaign the operator dismissed the interval panel for. */
  const [intervalPanelDismissedFor, setIntervalPanelDismissedFor] = useState(null);

  /**
   * The most recent operator-facing message, with the moment it was raised.
   *
   * Timestamped so the results line can choose between this and the campaign description
   * derived from /status, instead of the two racing to overwrite one piece of state. The
   * old dashboard had exactly that race: an action message would appear and then be
   * silently replaced by the next poll a second later.
   */
  const [notice, setNoticeState] = useState({ message: '', at: 0 });

  const form = useCampaignForm();

  /**
   * Routes a progress message to both surfaces.
   *
   * The results line is state that persists; the toast makes sure an operator looking
   * elsewhere on the page still notices.
   */
  const raiseNotice = useCallback(
    (message) => {
      if (!message) return;
      setNoticeState({ message, at: Date.now() });
      toast.show(message);
    },
    [toast]
  );

  const imap = useImapTesting({ onNotice: raiseNotice });
  const lane = useCampaignLane({ onNotice: raiseNotice });

  const fileIds = form.form.fileIds;
  const isTestMode = form.isTestMode;

  const statusRefreshRef = useRef(null);

  const handleStatusRefresh = useCallback((sessionId) => {
    statusRefreshRef.current?.(sessionId);
  }, []);

  const send = useCampaignSend({
    form: form.form,
    bounds: appConfig.limits,
    onNotice: raiseNotice,
    onStatusRefresh: handleStatusRefresh,
    lane
  });

  /**
   * Which campaign is being watched — derived, not stored.
   *
   * A bulk campaign is identified by the first File ID in the form, so simply having one
   * there is enough to attach the live view. That is what makes a reload recover a running
   * campaign: polling used to start only from the submit success path, which left a live
   * campaign with no poller after a refresh. The counters froze, operators read that as a
   * stalled campaign, and the workaround was a browser extension reloading the page every
   * few seconds — which consumed the very rate-limit allowance campaign submission needed.
   *
   * Attaching to a finished campaign is harmless: useCampaignStatus stops polling as soon as
   * a reading comes back terminal, so the cost is one request.
   *
   * A test send has no file, so it uses the timestamped id minted at submit.
   */
  const watchedSessionId = isTestMode ? send.sessionId : (parseFileIds(fileIds)[0] ?? null);

  const status = useCampaignStatus(watchedSessionId, { enabled: Boolean(watchedSessionId) });

  // Closes the loop: the send hook asks for an immediate status read after a submit or a
  // stop, and the query it must refresh is declared after it.
  useEffect(() => {
    statusRefreshRef.current = status.refreshNow;
  }, [status.refreshNow]);

  /**
   * Current values of the composed hooks, for callbacks and effects that must not re-run
   * merely because a hook object was rebuilt.
   *
   * Written in an effect rather than during render. Effects run before any user
   * interaction and before the effects declared after this one, so every reader sees
   * current values.
   */
  const latest = useRef({ form, send, status, lane, imap });

  useEffect(() => {
    latest.current = { form, send, status, lane, imap };
  }, [form, send, status, lane, imap]);

  /* ---- Actions ---------------------------------------------------------- */

  const handleSend = useCallback(async () => {
    const current = latest.current;

    if (current.form.hasPendingInboxPatternSelection) {
      raiseNotice('⏳ Waiting to verify the saved Inbox Pattern. Retry loading patterns if needed.');
      return;
    }

    const result = await current.send.submit({
      onBeforeSubmit: () => {
        // Commit keystrokes still inside the autosave debounce window.
        current.form.flushDraft();

        // Drop a password the browser autofilled on its own. /send-email prefers a
        // submitted password over the stored one, so leaving it in place would
        // authenticate with a string the operator never chose.
        if (current.form.discardUngesturedPassword()) {
          return { ...current.form.form, smtpPass: '' };
        }
        return current.form.form;
      }
    });

    // No need to record the session id: for a bulk campaign it is already the first File ID
    // in the form, and for a test send the send hook holds it — either way `watchedSessionId`
    // is derived from state that has already moved.
    if (!result?.ok) return;

    // A test send with Auto IMAP Test on: the returned testIds are what the checker looks
    // for in each mailbox.
    const formState = current.form.form;
    if (formState.testBulk === 'Test' && formState.autoImapTest && result.data?.testIds?.length) {
      current.imap.scheduleAutoCheck(result.data.testIds, parseTestRecipients(formState.testRecipients));
    }
  }, [raiseNotice]);

  const [isDownloadingLog, setIsDownloadingLog] = useState(false);

  const handleDownloadLog = useCallback(async () => {
    if (!watchedSessionId) return;

    setIsDownloadingLog(true);
    try {
      await downloadLog(watchedSessionId);
    } catch (err) {
      raiseNotice(`❌ Could not download the log: ${err.message}`);
    } finally {
      setIsDownloadingLog(false);
    }
  }, [watchedSessionId, raiseNotice]);

  const handleStop = useCallback(async () => {
    const ok = await confirm({
      title: 'Stop sending this campaign?',
      message: [
        'No further emails will be sent for this campaign.',
        'Emails already delivered stay delivered, and the remaining recipients stay pending — you can change Limit and Interval and send them later.'
      ],
      confirmLabel: 'Stop Sending',
      cancelLabel: 'Keep Sending',
      tone: 'danger'
    });

    if (!ok) return;

    latest.current.imap.cancelAutoCheck();
    await latest.current.send.stop(watchedSessionId);
  }, [confirm, watchedSessionId]);

  /**
   * Recovers a queue wait interrupted by a reload.
   *
   * If this tab was waiting its turn and was cleared while away, the operator already
   * pressed Send — so the submission is resumed rather than requiring another click.
   * Runs at most once per mount.
   */
  const resumeAttempted = useRef(false);

  useEffect(() => {
    if (resumeAttempted.current || isTestMode || form.hasPendingInboxPatternSelection) return;

    const [firstId] = parseFileIds(fileIds);
    if (!firstId) return;

    resumeAttempted.current = true;

    latest.current.lane.resumeAfterReload(firstId).then((cleared) => {
      if (!cleared) return;
      raiseNotice('▶️ Resuming the campaign you queued before the page reloaded…');
      handleSend();
    });
  }, [fileIds, isTestMode, form.hasPendingInboxPatternSelection, handleSend, raiseNotice]);

  /* ---- Status-driven UI -------------------------------------------------- */

  const statusData = status.status;

  /**
   * The results line: the campaign description, unless an action said something more
   * recently.
   *
   * Derived rather than stored. The server's verdict on whether a campaign is stopped is
   * what makes a stop issued in another tab, or by another operator, appear here too — and
   * deriving it means that verdict cannot be lost to a stale write.
   */
  const campaignLine = useMemo(() => (statusData ? describeCampaign(statusData) : ''), [statusData]);

  const resultsMessage =
    notice.at >= status.updatedAt || !campaignLine ? notice.message : campaignLine;

  // Mirrors the server's stop verdict into the send hook, so a pending 429 retry cannot
  // resurrect a campaign stopped elsewhere. Writes a ref only — no state, no re-render.
  useEffect(() => {
    if (!statusData) return;
    latest.current.send.markStopped(Boolean(statusData.stopped));
  }, [statusData]);

  /**
   * Keeps the lane heartbeat and the server's reconciler running while a campaign is
   * being watched.
   *
   * GET /campaign-lane is the only caller of that reconciler, and the only thing that ever
   * marks a campaign completed and promotes the next one. Stop polling it and campaigns
   * sit at 'in_progress' forever and the lane never drains.
   */
  const laneKeepAlive = lane.keepAlive;
  const laneIsWaiting = lane.isWaiting;

  useEffect(() => {
    if (!watchedSessionId || String(watchedSessionId).startsWith('test-')) return undefined;
    if (laneIsWaiting) return undefined;
    return laneKeepAlive(watchedSessionId);
  }, [watchedSessionId, laneIsWaiting, laneKeepAlive]);

  /* ---- Auto IMAP test gating -------------------------------------------- */

  const testRecipients = parseTestRecipients(form.form.testRecipients);
  const recipientsWithoutAccounts = testRecipients.filter(
    (recipient) => !imap.accounts.some((account) => account.email === recipient)
  );

  const autoImapBlockedReason = !isTestMode
    ? 'Available in Test mode only.'
    : imap.accounts.length === 0
      ? 'Add IMAP accounts on the IMAP Setup page first.'
      : !imap.credentials?.host
        ? 'Configure the IMAP server on the IMAP Setup page first.'
        : testRecipients.length === 0
          ? 'Enter test recipients first.'
          : recipientsWithoutAccounts.length > 0
            ? `No IMAP account for: ${recipientsWithoutAccounts.join(', ')}`
            : undefined;

  const autoImapAvailable = isTestMode && !autoImapBlockedReason;
  const autoImapChecked = Boolean(form.form.autoImapTest);
  const setField = form.setField;

  /**
   * Treated as off whenever it cannot run, rather than being switched off in an effect.
   *
   * The old form let the checkbox stay ticked after a switch to Bulk, where it silently did
   * nothing. Deriving the effective value means the box cannot show armed while being
   * inert, and no extra render is needed to correct it.
   */
  const autoImapEffective = autoImapChecked && autoImapAvailable;

  const selectedInboxPatternName =
    form.inboxPatterns.find((pattern) => pattern.id === form.form.inboxPatternId)?.name ??
    'Default (existing behavior)';

  /* ---- Derived view state ---------------------------------------------- */

  const hasCampaign = Boolean(watchedSessionId) && Boolean(statusData);
  const isStopped = Boolean(statusData?.stopped);

  /**
   * Whether a campaign has actually been submitted for this session id.
   *
   * `campaignStatus` is null until an EmailLog exists, and `sentIndex` is 0 until work has
   * been released, so together they distinguish a live campaign from a recipient file that
   * has merely been selected in the form.
   *
   * The distinction matters for the Stop button. Selecting a file makes /status report
   * `total: 41, sent: 0`, which is not terminal — so a rule based only on "recipients
   * remain" offers Stop for a campaign that has never started. The old UI did exactly that.
   * Stopping then writes a stop marker against a campaign that was never running, which is
   * harmless but says something untrue about the state of the system.
   */
  const campaignStarted = Boolean(statusData?.campaignStatus) || (statusData?.sentIndex ?? 0) > 0;

  // Offered while the campaign has recipients left, because that is the whole window in
  // which stopping means anything.
  const canStop = hasCampaign && campaignStarted && !isStopped && !status.isTerminal;

  /**
   * The rate inputs lock only while work is genuinely in flight.
   *
   * Tying this to "the campaign is unfinished" instead would break the ordinary unpaced
   * workflow: Limit is a batch size there, the campaign goes idle between batches, and
   * re-tuning it before submitting the next one is the intended way to use it. Locking it
   * in that state would leave the operator with a Send Email button and no way to change
   * what it sends.
   */
  const rateInputsLocked = status.isSending;

  // Dismissal is scoped to the campaign it was made for, so a new campaign brings the panel
  // back without needing an effect to reset a boolean.
  const intervalPanelDismissed = intervalPanelDismissedFor === watchedSessionId;

  const showIntervalPanel =
    hasCampaign && status.isPaced && !intervalPanelDismissed && !(status.isTerminal && !isStopped);

  return (
    <div className="flex flex-col gap-4">
      <SystemHealthStrip />

      <div
        className={`grid min-w-0 grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] ${
          showTestResults
            ? '2xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,var(--sidebar-w))]'
            : '2xl:grid-cols-[minmax(0,calc((100%_-_var(--sidebar-w)_-_2rem)/2))_minmax(0,1fr)]'
        }`}
      >
        <div className="flex min-w-0 flex-col gap-4">
          <SmtpCredentialsCard
            form={form.form}
            setField={setField}
            hasSavedPassword={form.hasSavedPassword}
            passwordIntent={form.passwordIntent}
            onPasswordIntent={form.registerPasswordIntent}
            onPasswordChange={form.setPassword}
          />

          {isTestMode ? (
            <TestLiveStatus
              status={statusData}
              onRefresh={() => status.refreshNow()}
              isRefreshing={status.isFetching}
            />
          ) : (
            <BulkLiveStatus
              status={statusData}
              batchLimit={send.lastBatch?.limit ?? (Number(form.form.limit) || 0)}
              isStopped={isStopped}
              campaignStatus={statusData?.campaignStatus}
            />
          )}

          <ResultsLine
            message={resultsMessage}
            canDownloadLog={hasCampaign && (statusData?.failed ?? 0) > 0}
            isDownloadingLog={isDownloadingLog}
            onDownloadLog={handleDownloadLog}
          />
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <EmailConfigCard
            form={form.form}
            setField={setField}
            limits={appConfig.limits}
            validationError={send.validationError}
            isTestMode={isTestMode}
            rateInputsLocked={rateInputsLocked}
            inboxPatterns={form.inboxPatterns}
            isLoadingInboxPatterns={form.isLoadingInboxPatterns}
            inboxPatternsError={form.inboxPatternsError}
            onRetryInboxPatterns={() => form.refetchInboxPatterns()}
            autoImapAvailable={autoImapAvailable}
            autoImapChecked={autoImapEffective}
            onPreview={() => setShowPreview(true)}
            onMessageIdHelp={() => setShowMessageIdHelp(true)}
            onHowToUse={() => setShowHowToUse(true)}
            onSend={handleSend}
            onStop={handleStop}
            isSubmitting={send.isSubmitting}
            isStopping={send.isStopping}
            canStop={canStop}
            onOpenTestResults={() => setShowTestResults(true)}
            laneBanner={
              lane.isWaiting ? (
                <p
                  className="flex flex-wrap items-center gap-2 rounded-md border border-warning-500/40 bg-warning-50 px-3 py-2 text-base text-warning-700"
                  role="status"
                  aria-live="polite"
                >
                  <i className="fa-solid fa-hourglass-half" aria-hidden="true" />
                  <span className="min-w-0 flex-1">
                    Waiting for the previous campaign to complete
                    {lane.waitingAhead > 0
                      ? ` — ${lane.waitingAhead} campaign${lane.waitingAhead === 1 ? '' : 's'} ahead of this one.`
                      : '…'}
                  </span>
                  <button type="button" onClick={() => lane.cancelWait()} className="font-semibold underline">
                    Leave the queue
                  </button>
                </p>
              ) : null
            }
          />
        </div>

        {showTestResults ? (
          <div className="flex min-w-0 flex-col gap-4 xl:col-span-2 2xl:col-span-1">
            <TestResultsPanel
              imap={imap}
              isAutoMode={autoImapEffective}
              onClose={() => setShowTestResults(false)}
            />
          </div>
        ) : null}
      </div>

      {showIntervalPanel ? (
        <IntervalPopup
          status={statusData}
          onStop={handleStop}
          onClose={() => setIntervalPanelDismissedFor(watchedSessionId)}
          isStopping={send.isStopping}
        />
      ) : null}

      <MessagePreviewModal
        open={showPreview}
        onClose={() => setShowPreview(false)}
        message={form.form.message}
        messageType={form.form.messageType}
        inboxPatternName={selectedInboxPatternName}
      />

      <MessageIdHelpModal open={showMessageIdHelp} onClose={() => setShowMessageIdHelp(false)} />
      <HowToUseModal open={showHowToUse} onClose={() => setShowHowToUse(false)} />
    </div>
  );
}
