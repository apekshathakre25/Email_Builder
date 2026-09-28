let sessionId = null;
let lastLimit = 0;
let lastBatchCount = 0;
let isSending = false;

/**
 * Whether the campaign the page is watching has been stopped.
 *
 * Set from the /status response, not from the click that requested the stop. The
 * server is the only thing that knows whether sending actually ceased, and reading
 * it back means a stop issued from another tab — or by another operator — reaches
 * this page too. The click is a request; this flag is the answer.
 */
let campaignStopped = false;

/**
 * Handle for the automatic re-submission scheduled after an HTTP 429.
 *
 * Kept so it can be cancelled. Without this, stopping a campaign that had just
 * been rate-limited would look stopped for a few seconds and then restart itself,
 * because the retry fires on a timer that knows nothing about the stop.
 */
let pendingResubmitTimer = null;

let currentLogs = [];
let currentPage = 1;
let totalPages = 1;
let logsPerPage = 10;

let currentFiles = [];
let currentFilePage = 1;
let totalFilePages = 1;
let filesPerPage = 10;

async function loadFiles(page = 1) {
  try {
    const cacheBuster = Date.now();
    const response = await fetch(`/files?page=${page}&limit=${filesPerPage}&sortBy=uploadDate&sortOrder=desc&_=${cacheBuster}`);
    if (!response.ok) {
      throw new Error('Failed to load files');
    }

    const data = await response.json();
    currentFiles = data.files;
    currentFilePage = data.pagination.page;
    totalFilePages = data.pagination.totalPages;

    return data;
  } catch (error) {
    console.error('Error loading files:', error);
    showError('Failed to load files: ' + error.message);
    return null;
  }
}

async function loadLogs(page = 1, retries = 3) {
  try {
    const cacheBuster = Date.now();
    const response = await fetch(`/logs?page=${page}&limit=${logsPerPage}&sortBy=createdAt&sortOrder=desc&_=${cacheBuster}`);

    if (!response.ok) {

       throw new Error(`Failed to load logs (HTTP ${response.status})`);
    }

    const data = await response.json();
    currentLogs = data.logs;
    currentPage = data.pagination.page;
    totalPages = data.pagination.totalPages;

    updateLogDisplay();
    return data;
  } catch (error) {
    console.warn(`Attempt to load logs failed: ${error.message}. Retries left: ${retries}`);

    if (retries > 0) {

       const delay = (4 - retries) * 1000;
       await new Promise(resolve => setTimeout(resolve, delay));
       return loadLogs(page, retries - 1);
    }

    console.error('Final attempt to load logs failed:', error);

    if (!isPolling) {
       showError('Failed to load logs: ' + error.message);
    }
    return null;
  }
}

function updateLogDisplay() {
  const logCount = currentLogs.length;
  const logBtn = document.getElementById('Download-log');
  const deleteBtn = document.getElementById('delete-log');

  if (logBtn) {
    logBtn.innerHTML = `<i class="fa-solid fa-download"></i> Download Log (${logCount})`;
    logBtn.disabled = logCount === 0;
  }

  if (deleteBtn) {
    deleteBtn.innerHTML = `<i class="fa-solid fa-trash"></i> Delete Log (${logCount})`;
    deleteBtn.disabled = logCount === 0;
  }
}

// Form state is persisted per user by public/js/form-persistence.js, which keeps
// the draft server-side in EmailConfig. It replaced a localStorage copy of the
// host/port/user that was written only on submit and was shared by every account
// using the same browser profile.

/**
 * Validates the Limit / Interval pair, returning an error string or ''.
 *
 * Bounds are duplicated from utils/emailRateLimiter.js (LIMIT_MIN/LIMIT_MAX,
 * INTERVAL_SECONDS_MIN/INTERVAL_SECONDS_MAX). If those change, change them here
 * too — the server stays authoritative either way, so a drift shows up as a 400
 * rather than as an accepted bad value.
 *
 * Both fields empty is valid and means "no rate limit", which is how every
 * campaign behaved before the interval field existed.
 */
const RATE_LIMIT_MIN = 1;
const RATE_LIMIT_MAX = 1000000;
const RATE_INTERVAL_MIN_SECONDS = 0.1;
const RATE_INTERVAL_MAX_SECONDS = 3600;

/**
 * Bounds for Limit to Send. Mirrors LIMIT_TO_SEND_MIN/MAX in routes/sendemails.js, which
 * re-checks every value — this only exists so a typo is reported without a round trip.
 *
 * A wider ceiling than the rate's on purpose: this counts recipients, and a campaign can
 * legitimately exceed a million, so the bound is only a typo guard.
 */
const LIMIT_TO_SEND_MIN = 1;
const LIMIT_TO_SEND_MAX = 10000000;

/**
 * Validates the per-action cap. Empty is valid and means "no cap".
 *
 * Deliberately independent of the rate check: Limit to Send is a batch size, not a
 * second rate, so it neither requires nor constrains Limit and Interval.
 */
function validateLimitToSend(raw) {
  const text = (raw === null || raw === undefined ? '' : String(raw)).trim();
  if (text === '') return '';

  const value = Number(text);

  if (!Number.isInteger(value)) {
    return 'Limit to Send must be a whole number of emails (got "' + text + '").';
  }
  if (value < LIMIT_TO_SEND_MIN) {
    return 'Limit to Send must be at least ' + LIMIT_TO_SEND_MIN +
      ' — leave it empty for no limit (got ' + value + ').';
  }
  if (value > LIMIT_TO_SEND_MAX) {
    return 'Limit to Send must be ' + LIMIT_TO_SEND_MAX + ' or less (got ' + value + ').';
  }

  return '';
}

function validateSendRate(limitRaw, intervalRaw) {
  const limit = (limitRaw === null || limitRaw === undefined ? '' : String(limitRaw)).trim();
  const interval = (intervalRaw === null || intervalRaw === undefined ? '' : String(intervalRaw)).trim();

  if (limit !== '') {
    // Number(), not parseInt(): parseInt('35abc') is 35, which would let a typo
    // through as a valid rate.
    const value = Number(limit);
    if (!Number.isInteger(value)) {
      return 'Limit must be a whole number of emails (got "' + limit + '").';
    }
    if (value < RATE_LIMIT_MIN || value > RATE_LIMIT_MAX) {
      return 'Limit must be between ' + RATE_LIMIT_MIN + ' and ' + RATE_LIMIT_MAX + '.';
    }
  }

  if (interval === '') return '';

  const seconds = Number(interval);
  if (!Number.isFinite(seconds)) {
    return 'Interval (seconds) must be a number (got "' + interval + '").';
  }
  if (seconds < RATE_INTERVAL_MIN_SECONDS || seconds > RATE_INTERVAL_MAX_SECONDS) {
    return 'Interval (seconds) must be between ' + RATE_INTERVAL_MIN_SECONDS +
      ' and ' + RATE_INTERVAL_MAX_SECONDS + '.';
  }
  if (limit === '') {
    return 'Interval (seconds) needs a Limit — Limit is how many emails each interval allows.';
  }

  return '';
}

/**
 * Locks or unlocks the send-rate inputs.
 *
 * Locked while a campaign is running, because the rate is fixed when a batch is
 * enqueued — the jobs already carry it — so editing the fields mid-campaign would
 * change the numbers on screen without changing what the workers do. Unlocked the
 * moment the campaign stops or finishes, which is what lets the operator set a new
 * Limit and Interval and start again.
 *
 * `readOnly`, emphatically not `disabled`. A disabled control is omitted from
 * FormData, so locking these with `disabled` would make the next submission post an
 * empty `limit` and `interval-seconds` — and an absent interval is precisely how the
 * server is told "no rate limit". Locking the fields would therefore have silently
 * converted the next batch of a paced campaign into an unpaced one that sends every
 * remaining recipient as fast as SMTP allows. `readOnly` prevents editing while
 * still submitting the values.
 */
function setRateInputsLocked(locked) {
  for (const id of ['limit', 'interval-seconds']) {
    const el = document.getElementById(id);
    if (!el) continue;

    el.readOnly = Boolean(locked);
    el.setAttribute('aria-readonly', locked ? 'true' : 'false');
    el.title = locked
      ? 'Stop sending to change the rate. The running campaign already has this rate applied.'
      : '';
  }
}

/** Shows or hides both Stop Sending buttons together. They are one control. */
function setStopControlsVisible(visible) {
  const mainBtn = document.getElementById('stop-sending');
  if (mainBtn) mainBtn.hidden = !visible;
}

/** Cancels a queued 429 retry, so a stop cannot be undone by a pending timer. */
function cancelPendingResubmit() {
  if (pendingResubmitTimer) {
    clearTimeout(pendingResubmitTimer);
    pendingResubmitTimer = null;
  }
}

/**
 * Puts the page into the stopped state.
 *
 * Called only once the server has confirmed the stop, or once /status reports one.
 * Every visible consequence of a stop is applied from this one place so the two
 * buttons, a stop from another tab and a page reload all produce the same UI.
 */
function applyStoppedState(message) {
  campaignStopped = true;
  isSending = false;

  cancelPendingResubmit();
  stopStatusPolling();
  stopIntervalCountdown();

  setStopControlsVisible(false);
  setRateInputsLocked(false);
  markIntervalPopupStopped();

  if (message) showError(message);
}

/**
 * Asks the operator to confirm the stop.
 *
 * Uses the application's own dialog (public/js/confirm-dialog.js) rather than
 * `window.confirm`. The native dialog put browser chrome — "localhost:3000 says" —
 * around the most consequential action in the product, and because it blocks the
 * main thread it also froze the status poller and the interval countdown for as long
 * as it was open, so the numbers behind it were stale the moment it was answered.
 *
 * Falls back to `window.confirm` if the module did not load. A missing script must
 * not leave the operator unable to stop a campaign.
 */
function askToStop() {
  const lines = [
    'No further emails will be sent for this campaign.',
    'Emails already delivered stay delivered, and the remaining recipients stay ' +
    'pending — you can change Limit and Interval and send them later.'
  ];

  if (window.ConfirmDialog && typeof window.ConfirmDialog.confirm === 'function') {
    return window.ConfirmDialog.confirm({
      title: 'Stop sending this campaign?',
      message: lines,
      confirmLabel: 'Stop Sending',
      cancelLabel: 'Keep Sending',
      tone: 'danger'
    });
  }

  return Promise.resolve(window.confirm('Stop sending this campaign?\n\n' + lines.join('\n\n')));
}

/**
 * THE stop action. Both buttons call this; there is nothing else to call.
 *
 * Deliberately does not touch the countdown or the counters before the request
 * returns. A UI that goes quiet on click and only then asks the server to stop is
 * the failure this feature exists to avoid — it teaches the operator to trust the
 * screen over the mail server. So the request goes first, and the display changes
 * when the server confirms the stop is in force.
 */
async function stopSending(options) {
  const opts = options || {};
  const target = sessionId || window.currentSessionId;

  if (!target) {
    showError('⚠️ There is no campaign to stop yet.');
    return;
  }

  if (!opts.skipConfirm) {
    const ok = await askToStop();
    if (!ok) return;
  }

  // Cancelled immediately rather than after the response: a 429 retry that fires
  // while the stop request is still in flight would enqueue another batch.
  cancelPendingResubmit();

  const buttons = Array.from(document.querySelectorAll('[data-stop-sending]'))
    .concat(document.getElementById('stop-sending') || []);

  for (const btn of buttons) {
    if (btn) btn.disabled = true;
  }

  showError('⏳ Stopping — waiting for the server to confirm no more emails will be released…');

  try {
    const res = await fetch('/stop-sending', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: target })
    });

    let data;
    try { data = await res.json(); } catch { data = {}; }

    if (!res.ok) {
      // The campaign is still running, so the UI must keep saying so.
      for (const btn of buttons) {
        if (btn) btn.disabled = false;
      }
      showError(
        `❌ Could not stop the campaign: ${data.error || data.message || 'HTTP ' + res.status}. ` +
        'Sending is still in progress — try again.'
      );
      return;
    }

    const tally = `${data.sent || 0} sent, ${data.failed || 0} failed, ${data.pending || 0} still pending`;
    applyStoppedState(
      data.alreadyStopped
        ? `⏹️ This campaign was already stopped — ${tally}. Change Limit/Interval and click Send Email to continue.`
        : `⏹️ Sending stopped — ${tally}. Change Limit/Interval and click Send Email to continue.`
    );

    // One last read, so the counters settle on whatever the in-flight sends
    // finished with rather than freezing at the moment of the click.
    setTimeout(() => { pollStatusOnce(target); }, 1200);
  } catch (err) {
    for (const btn of buttons) {
      if (btn) btn.disabled = false;
    }
    showError(
      `⚠️ Could not reach the server to stop the campaign (${err.message || err}). ` +
      'Sending may still be in progress — try again.'
    );
  } finally {
    for (const btn of buttons) {
      if (btn) btn.disabled = false;
    }
  }
}

const stopSendingBtn = document.getElementById('stop-sending');
if (stopSendingBtn) {
  stopSendingBtn.addEventListener('click', () => stopSending());
}

const emailForm = document.getElementById('email-form');
if (emailForm) {
  emailForm.addEventListener('submit', async function (e) {
    e.preventDefault();

    // Commit any keystrokes still inside the autosave debounce window.
    if (window.FormPersistence) window.FormPersistence.flush();

    // Drop an SMTP password the browser autofilled on its own. It would otherwise
    // be submitted below and, because /send-email prefers a submitted password
    // over the stored one, the campaign would authenticate with a string the
    // operator never chose. An empty field is how this form asks the server to use
    // the saved credential, so this restores that rather than losing anything.
    // Called here, before the FormData snapshot, because form-persistence.js binds
    // its own submit listener after this handler and so cannot get in first.
    if (window.FormPersistence && window.FormPersistence.discardUngesturedPassword) {
      window.FormPersistence.discardUngesturedPassword();
    }

    if (bulkRadio && bulkRadio.checked) {
      const fileIdsField = document.getElementById('file-ids');
      const fileIds = fileIdsField ? fileIdsField.value.trim() : '';

      if (!fileIds) {
        showError('❌ File IDs are mandatory for bulk campaigns. Please add file IDs to proceed.');
        return;
      }

      const fileIdArray = fileIds.split(',').map(id => id.trim()).filter(id => id);
      if (fileIdArray.length === 0) {
        showError('❌ Please provide at least one valid File ID for bulk campaigns.');
        return;
      }
    }

    const formData = new FormData(emailForm);

    if (testRadio && testRadio.checked) {

      sessionId = `test-${Date.now()}`;
      formData.append('sessionId', sessionId);
      console.log('Added test sessionId to form:', sessionId);
    } else if (bulkRadio && bulkRadio.checked) {
      const fileIdsField = document.getElementById('file-ids');
      const fileIds = fileIdsField ? fileIdsField.value.trim() : '';
      if (fileIds) {
        const fileIdArray = fileIds.split(',').map(id => id.trim()).filter(id => id);
        if (fileIdArray.length > 0) {

          sessionId = fileIdArray[0];
          formData.append('sessionId', sessionId);
          console.log('Added bulk sessionId to form:', sessionId);
        } else {
          console.log('No valid file IDs found');
        }
      } else {
        console.log('No file IDs provided');
      }
    }

    // Send-rate validation. Mirrors utils/emailRateLimiter.js, which re-checks
    // every value server-side — this only exists so a typo is reported instantly
    // instead of costing a round trip.
    var rateError = validateSendRate(formData.get('limit'), formData.get('interval-seconds'));
    if (rateError) {
      showError('❌ ' + rateError);
      return;
    }

    var limitToSendError = validateLimitToSend(formData.get('limit-to-send'));
    if (limitToSendError) {
      showError('❌ ' + limitToSendError);
      return;
    }

    // One campaign per operator at a time. The server decides the order; this waits
    // for its turn and resolves true when cleared to send, so a second tab holds here
    // instead of sending alongside the first. Placed after every local validation so
    // a misconfigured form is reported immediately rather than after a queue wait.
    //
    // Resolves true immediately for test-mode sends and when no sequencer is loaded,
    // so behaviour without this feature is unchanged.
    if (window.CampaignSequencer) {
      const cleared = await window.CampaignSequencer.requestSend();
      if (!cleared) return;
    }

    lastLimit = parseInt(formData.get('limit')) || 0;
    isSending = true;

    // A submission is a fresh start, including after a stop. The flag is cleared
    // here so the poller can set it again from the server rather than inheriting
    // the previous campaign's verdict, and any retry left over from a 429 on the
    // previous attempt is discarded so it cannot fire against this one.
    campaignStopped = false;
    cancelPendingResubmit();
    closeIntervalPopup();

    const formDataObj = Object.fromEntries(formData.entries());
    console.log('Sending form data:', formDataObj);

    fetch('/send-email', {
      method: 'POST',
      body: new URLSearchParams([...formData])
    })
      .then(async res => {
        let data;
        try { data = await res.json(); } catch { data = {}; }
        if (!res.ok) {
          isSending = false;

          // A rejected submission is not a failed campaign. Anything already
          // queued keeps sending; only this batch was refused. Saying "Send
          // failed." here is what led operators to believe a running campaign
          // had died.
          if (res.status === 429 || data.code === 'RATE_LIMITED') {
            const wait = data.retryAfterSeconds ? ` Retrying in ${data.retryAfterSeconds}s.` : '';
            showError(`⏳ ${data.message || data.error || 'Too many requests.'}${wait} Emails already queued keep sending.`);

            // Retry once the window has rolled over, so a transient 429 does not
            // require the operator to notice and click again. Retry-After comes
            // from the limiter's draft-7 standardHeaders.
            //
            // The handle is kept, and the stop flag re-checked when it fires, so
            // this cannot resurrect a campaign the operator stopped in the
            // meantime — which would otherwise look like the stop silently failed.
            const retryMs = Math.min(60, Math.max(2, data.retryAfterSeconds || 10)) * 1000;
            cancelPendingResubmit();
            pendingResubmitTimer = setTimeout(() => {
              pendingResubmitTimer = null;
              if (campaignStopped) {
                showError('⏹️ Sending is stopped — the queued retry was cancelled.');
                return;
              }
              if (emailForm) emailForm.requestSubmit();
            }, retryMs);
            return;
          }

          if (res.status === 401 || res.status === 403) {
            showError('🔒 Your session expired. Please sign in again — queued emails keep sending.');
            return;
          }

          // A real, specific rejection from the application (bad file id, no
          // recipients left, oversized payload) carries its own text.
          if (data.error || data.message) {
            showError(`❌ ${data.error || data.message}`);
            return;
          }

          // Non-JSON body: a proxy 502/504 or similar. The request may well have
          // been processed server-side, so do not claim the send failed.
          showError(`⚠️ The server returned HTTP ${res.status} without details. Check the status counters before resubmitting.`);
          return;
        }
        if (data.status === 'enqueued') {
          showError('');
          lastBatchCount = data.batchCount;

          // Confirms to the sequencer that the submission landed, so a later batch of
          // this same campaign from this tab is recognised as a continuation rather
          // than a second tab trying to start it.
          if (window.CampaignSequencer) window.CampaignSequencer.markSubmitted();

          // There is now a campaign to stop, and the rate is fixed for the work
          // just enqueued, so the inputs lock until it stops or finishes.
          setStopControlsVisible(true);
          setRateInputsLocked(true);

          if (testRadio && testRadio.checked) {
          } else if (bulkRadio && bulkRadio.checked) {
            // Queue and Limit only. Both are known exactly and locally: this batch
            // was just accepted, and the limit is what was typed into the form.
            //
            // Pending is deliberately NOT written here any more. It used to be
            // decremented by the batch size at submit, which is what made it look
            // like the responsive counter while Sent looked broken — it was
            // reporting work as no longer pending the moment it was *queued*,
            // before a single email had been sent, and from a number the browser
            // made up rather than anything the server agreed with. The next poll
            // then overwrote it with total - sent - failed, so it visibly jumped
            // back up. /status now returns `pending` and this waits for it.
            document.getElementById('bulk-queue').textContent = lastBatchCount;
            document.getElementById('bulk-total-sending').textContent = lastLimit;
          }

          startStatusPolling();
          loadLogs();
          if (testRadio && testRadio.checked) {
            const testRecpField = document.getElementById('test-recp');
            const testRecipients = testRecpField ? testRecpField.value.trim() : '';
            showError(`✅ Test campaign started! ${lastBatchCount} test emails moved from pending to queue. Recipients: ${testRecipients}`);

            const recipients = testRecipients.split(/[,\n]/).map(e => e.trim()).filter(e => e);
            const smtpHost = document.getElementById('smtp-host')?.value || '';
            const subject = document.getElementById('subject')?.value || '';
            const fromEmail = document.getElementById('smtp-from-email')?.value || '';

            if (window.handleAutoImapTest && typeof window.handleAutoImapTest === 'function' && data.testIds && data.testIds.length > 0) {

              window.handleAutoImapTest(recipients, smtpHost, subject, fromEmail, data.testIds);
            } else if (!window.handleAutoImapTest && data.testIds && data.testIds.length > 0) {

              console.log(`✅ Saved ${data.testIds.length} test records on backend`);
            }
          } else if (bulkRadio && bulkRadio.checked) {

            const fileIdsField = document.getElementById('file-ids');
            if (fileIdsField && fileIdsField.value.trim()) {
              showError(`✅ Bulk campaign started! ${lastBatchCount} emails moved from pending to queue. File IDs: ${fileIdsField.value.trim()}`);
            }
          }
        } else if (data.error) {
          showError(data.error);
        }
      })
      .catch(err => {
        isSending = false;

        // The fetch itself never completed: connection dropped, navigation
        // aborted it (a page refresh does exactly this), or the proxy timed out.
        // The server may still have accepted and enqueued the batch, so this is
        // explicitly not reported as a failed campaign.
        showError(
          '⚠️ Could not confirm the request reached the server (' +
          (err.message || err) +
          '). Anything already queued keeps sending — check the counters before resubmitting.'
        );
      });
  });
}

/* --------------------------------------------------------------------------
   Interval status popup
   --------------------------------------------------------------------------
   Shows the rate a paced campaign is running at, its progress, and how long
   until the next interval opens — plus a Stop Sending button.

   The countdown is driven locally between polls but *anchored* to the server on
   every poll: /status returns window.resetInMs, read from the same Redis bucket
   the workers are gated on, and the local ticker only fills the 1.5s gap between
   readings. It is never the source of truth, which is why a stop cannot leave it
   counting down against a campaign that is no longer sending.

   Only ever shown for a campaign with a rate configured. Without an interval there
   are no intervals to report, so no popup appears.
   -------------------------------------------------------------------------- */

const INTERVAL_POPUP_ID = 'interval-status-popup';

let intervalCountdownTimer = null;
let intervalCountdownMs = 0;
let intervalCountdownAt = 0;

function formatCountdown(ms) {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function getIntervalPopup() {
  return document.getElementById(INTERVAL_POPUP_ID);
}

function closeIntervalPopup() {
  stopIntervalCountdown();
  const popup = getIntervalPopup();
  if (popup) popup.remove();
}

function buildIntervalPopup() {
  const popup = document.createElement('div');
  popup.id = INTERVAL_POPUP_ID;
  popup.className = 'interval-popup';
  popup.setAttribute('role', 'status');
  popup.setAttribute('aria-live', 'polite');

  popup.innerHTML = `
    <button type="button" class="interval-popup__close" aria-label="Hide this panel">
      <i class="fa-solid fa-xmark"></i>
    </button>
    <h3 class="interval-popup__title">Email Sending</h3>
    <dl class="interval-popup__grid">
      <dt>Limit</dt><dd data-field="limit">—</dd>
      <dt>Interval</dt><dd data-field="interval">—</dd>
      <dt>Sent</dt><dd data-field="sent">0</dd>
      <dt>Pending</dt><dd data-field="pending">0</dd>
      <dt>Next interval</dt><dd data-field="countdown">00:00</dd>
    </dl>
    <p class="interval-popup__note" data-field="note"></p>
    <button type="button" class="btn btn--danger interval-popup__stop" data-stop-sending>
      <i class="fa-solid fa-circle-stop"></i> Stop Sending
    </button>
  `;

  // Hiding the panel is not stopping the campaign. Closing it only removes the
  // display; the campaign keeps running and the button beside Send Email remains
  // the other way to stop it.
  popup.querySelector('.interval-popup__close').addEventListener('click', closeIntervalPopup);

  // The second entry point to the one stop operation. Same function, same request,
  // same result as the button beside Send Email.
  popup.querySelector('[data-stop-sending]').addEventListener('click', () => stopSending());

  document.body.appendChild(popup);
  return popup;
}

function stopIntervalCountdown() {
  if (intervalCountdownTimer) {
    clearInterval(intervalCountdownTimer);
    intervalCountdownTimer = null;
  }
}

function renderCountdown() {
  const popup = getIntervalPopup();
  if (!popup) {
    stopIntervalCountdown();
    return;
  }

  const field = popup.querySelector('[data-field="countdown"]');
  if (!field) return;

  const elapsed = Date.now() - intervalCountdownAt;
  field.textContent = formatCountdown(intervalCountdownMs - elapsed);
}

function startIntervalCountdown(resetInMs) {
  intervalCountdownMs = Math.max(0, Number(resetInMs) || 0);
  intervalCountdownAt = Date.now();

  renderCountdown();

  if (!intervalCountdownTimer) {
    intervalCountdownTimer = setInterval(renderCountdown, 250);
  }
}

/**
 * Turns the popup into a record of the stop.
 *
 * The panel is not closed outright: the operator has just asked for something
 * consequential and the final counters are what they want to see. The countdown is
 * halted, the stop button goes — there is nothing left to stop — and the note says
 * what happened.
 */
function markIntervalPopupStopped() {
  stopIntervalCountdown();

  const popup = getIntervalPopup();
  if (!popup) return;

  popup.classList.add('interval-popup--stopped');

  const countdown = popup.querySelector('[data-field="countdown"]');
  if (countdown) countdown.textContent = '—';

  const note = popup.querySelector('[data-field="note"]');
  if (note) note.textContent = 'Sending stopped. Remaining recipients are still pending.';

  const stopBtn = popup.querySelector('[data-stop-sending]');
  if (stopBtn) stopBtn.remove();
}

/**
 * Reflects a /status payload in the popup, creating it if this campaign is paced.
 *
 * Driven entirely by the response. When `rateLimit` is null the campaign has no
 * interval, so any popup left over from a previous campaign is removed rather than
 * shown with stale numbers.
 */
function updateIntervalPopup(data) {
  const rate = data && data.rateLimit;

  if (!rate || !rate.limit || !rate.intervalSeconds) {
    closeIntervalPopup();
    return;
  }

  const settled = (data.sent || 0) + (data.failed || 0);
  const finished = data.total > 0 && settled >= data.total;

  // Nothing left to report on a campaign that has finished on its own.
  if (finished && !data.stopped) {
    closeIntervalPopup();
    return;
  }

  const popup = getIntervalPopup() || buildIntervalPopup();

  const set = (field, value) => {
    const el = popup.querySelector(`[data-field="${field}"]`);
    if (el) el.textContent = value;
  };

  set('limit', `${rate.limit} emails`);
  set('interval', `${rate.intervalSeconds} second${rate.intervalSeconds === 1 ? '' : 's'}`);
  set('sent', data.sent || 0);
  set('pending', data.pending !== undefined ? data.pending : '—');

  if (data.stopped) {
    markIntervalPopupStopped();
    return;
  }

  const note = popup.querySelector('[data-field="note"]');
  if (note && data.window) {
    note.textContent = `Window usage ${data.window.used}/${data.window.limit}.`;
  }

  startIntervalCountdown(data.window ? data.window.resetInMs : 0);
}

let statusTimeout = null;
let isPolling = false;
let visibilityHookInstalled = false;

/**
 * Polling cadence.
 *
 * This was 3s for a reason that no longer holds. /status used to read its counts
 * from MongoDB, which BatchLogger only writes on a 2000ms timer, so polling
 * faster than the flush interval re-read numbers that could not have changed.
 * /status now reports the worker's live per-email Redis tally, so every poll
 * carries fresh data and the interval is the whole of the visible latency — which
 * is what operators were seeing as the Sent count "updating late".
 *
 * 1.5s is bounded by request budget rather than by data freshness. /status has its
 * own 600/min bucket (middleware/rateLimit.js), so one tab costs ~40/min and a
 * dozen tabs still fit. The incident that made 3s look necessary — status polling
 * starving POST /send-email — was a shared bucket, and that is what the dedicated
 * limiter fixed; it is not a reason to keep the interval high.
 *
 * The hidden-tab interval was 2s, which billed a background tab almost as much
 * as a foreground one for information nobody was looking at.
 */
const POLL_INTERVAL_SENDING = 1500;
const POLL_INTERVAL_IDLE = 10000;
const POLL_INTERVAL_HIDDEN = 30000;

function startStatusPolling() {
  if (isPolling) return;
  isPolling = true;
  console.log('Starting status polling with sessionId:', sessionId);

  if (statusTimeout) clearTimeout(statusTimeout);

  if (!sessionId) {
    console.log('No sessionId available for status polling');
    isPolling = false;
    return;
  }

  const runPoll = async () => {
    if (!isPolling) return;

    // A hidden tab still polls, just rarely, so returning to it shows something
    // recent rather than a frozen panel. The visibility hook below fetches
    // immediately on focus, so the long interval costs nothing perceptible.
    if (document.hidden) {
      statusTimeout = setTimeout(runPoll, POLL_INTERVAL_HIDDEN);
      return;
    }

    await pollStatus();

    // pollStatus() calls stopStatusPolling() once the campaign reaches a
    // terminal state, so re-check rather than scheduling unconditionally.
    if (!isPolling) return;

    statusTimeout = setTimeout(runPoll, isSending ? POLL_INTERVAL_SENDING : POLL_INTERVAL_IDLE);
  };

  runPoll();

  // Registered once per page, not once per campaign. This used to be added
  // inside startStatusPolling, so every campaign stacked another listener and
  // focusing the tab fired one runPoll per campaign ever started.
  if (!visibilityHookInstalled) {
    visibilityHookInstalled = true;

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && isPolling) {
        clearTimeout(statusTimeout);
        runPoll();
      }
    });
  }
}

/**
 * Composes the Results line from a /status payload.
 *
 * The distinction this function exists to preserve: a failed *recipient* is not
 * a failed *campaign*. `lastError` is reported as context on a campaign that is
 * still running, never as a terminal verdict.
 */
function describeCampaign(data) {
  const total = data.total || 0;
  const sent = data.sent || 0;
  const failed = data.failed || 0;
  const inFlight = data.sending || 0;
  const settled = sent + failed;
  const isTerminal = total > 0 && settled >= total;

  const tally = `${sent} sent, ${failed} failed of ${total}`;

  if (isTerminal) {
    return failed > 0
      ? `⚠️ Campaign finished — ${tally}. Some emails failed; download the log for details.`
      : `✅ Campaign complete — ${tally}.`;
  }

  let line = inFlight > 0
    ? `📤 Campaign is running — ${tally}, ${inFlight} in queue.`
    : `⏸️ Campaign is idle — ${tally}. Submit the next batch to continue.`;

  // Appended, not substituted: the campaign is still running and the counters
  // above are the headline. Previously this string replaced the entire line, so
  // one failed address looked identical to a dead campaign.
  if (data.lastError) {
    line += ` Most recent send error: ${data.lastError}`;
  }

  return line;
}

function stopStatusPolling() {
  isPolling = false;
  if (statusTimeout) {
    clearTimeout(statusTimeout);
    statusTimeout = null;
  }
}

async function pollStatus() {
  if (!sessionId) return;

  try {
    const res = await fetch(`/status?sessionId=${sessionId}`);
    if (!res.ok) {
       console.error('Status fetch failed');
       return;
    }

    const data = await res.json();
    if (data.total !== undefined) {

      const isTestMode = testRadio && testRadio.checked;
      const prefix = isTestMode ? 'test-' : 'bulk-';

      if (isTestMode) {
        document.getElementById(prefix + 'sent').textContent = data.sent || 0;
        document.getElementById(prefix + 'failed').textContent = data.failed || 0;
      } else {

        document.getElementById(prefix + 'total').textContent = data.total;

        const queueCount = data.sending || 0;
        const queueEl = document.getElementById(prefix + 'queue');
        if (queueEl) queueEl.textContent = queueCount;

        const totalSendingEl = document.getElementById(prefix + 'total-sending');
        if (totalSendingEl) totalSendingEl.textContent = lastLimit;

        // Server-provided. Computing it here from data.sent reproduced the
        // server's arithmetic in a second place and guaranteed the two could
        // disagree; `pending` now comes from the same read as `sent` and
        // `sending`, so all four counters describe one instant.
        const pendingEl = document.getElementById(prefix + 'pending');
        if (pendingEl) {
          const pending = data.pending !== undefined
            ? data.pending
            // Older server response: fall back so a cached client against a
            // not-yet-deployed backend still shows a sane number.
            : Math.max(0, data.total - (data.sent || 0) - (data.failed || 0));
          pendingEl.textContent = pending;
        }

        document.getElementById(prefix + 'sent').textContent = data.sent || 0;

        document.getElementById(prefix + 'failed').textContent = data.failed || 0;
      }

      window.currentSessionId = sessionId;

      // The server's verdict on whether sending has stopped, which overrides
      // anything this page believes. Handled before the counters are interpreted so
      // a stopped campaign cannot be described as running, and handled here rather
      // than only in the click handler so a stop issued in another tab, or by
      // another operator, is picked up within one poll.
      if (data.stopped) {
        const settledNow = (data.sent || 0) + (data.failed || 0);
        updateIntervalPopup(data);
        applyStoppedState(
          `⏹️ Sending stopped — ${data.sent || 0} sent, ${data.failed || 0} failed of ${data.total || 0}` +
          `, ${Math.max(0, (data.total || 0) - settledNow)} still pending. ` +
          'Change Limit/Interval and click Send Email to continue.'
        );
        return;
      }

      updateIntervalPopup(data);

      // `sending` is the server's own count of enqueued-but-not-yet-settled work
      // (sentIndex - sent - failed). Using it directly fixes a first-poll bug in
      // the previous condition, `(sent + failed) >= (sentIndex || 0)`, which was
      // trivially 0 >= 0 before the background enqueue had advanced sentIndex —
      // so every campaign immediately declared itself not-sending and dropped to
      // the slow poll interval.
      isSending = (data.sending || 0) > 0;

      const settled = (data.sent || 0) + (data.failed || 0);
      const reachedTerminalState = data.total > 0 && settled >= data.total;

      showError(describeCampaign(data));

      // The Stop button stays available while the campaign has recipients left,
      // because that is the whole window in which stopping means anything.
      setStopControlsVisible(!reachedTerminalState);

      // The rate inputs, though, are locked only while work is actually in flight.
      // Tying them to "the campaign is unfinished" instead would break the ordinary
      // unpaced workflow: `limit` is a batch size there, the campaign goes idle
      // between batches, and re-tuning the limit before submitting the next one is
      // the intended way to use it. Locking it in that state would leave the
      // operator with a Send Email button and no way to change what it sends.
      setRateInputsLocked(isSending);

      if (reachedTerminalState) {
        // Terminal means every recipient is accounted for. Stop polling rather
        // than querying a finished campaign forever.
        isSending = false;
        stopStatusPolling();
        closeIntervalPopup();
      }
    }
  } catch (err) {
    // A single failed poll is transient. Leave the last known good line in place
    // and try again on the next tick — it must never look like a failed campaign.
    console.error('Status fetch failed:', err);
  }
}

/**
 * One status read, outside the polling loop.
 *
 * Used after a stop is confirmed so the counters settle on what the in-flight sends
 * actually finished with, instead of freezing at the instant of the click. It does
 * not schedule anything, so it cannot restart polling on a stopped campaign.
 */
function pollStatusOnce(id) {
  if (id && !sessionId) sessionId = id;
  return pollStatus();
}

function showError(msg) {
  const errBox = document.getElementById('errors');
  if (errBox) errBox.textContent = msg;
}

const previewBtn = document.getElementById('preview-html');
if (previewBtn) {
  previewBtn.addEventListener('click', function () {
    // Read-only: the exact textarea value is what /send-email posts, so the
    // preview must not normalise, re-encode or rewrite it in any way.
    const msg = document.getElementById('message').value;
    const isHtml = document.getElementById('html').checked;

    if (isHtml) {
      showPopup('Preview', msg, { emailPreview: true });
    } else {
      showPopup(
        'Preview',
        `<pre style="white-space:pre-wrap;word-break:break-word;font-family:monospace;">${escapeHtml(msg)}</pre>`,
        { emailPreview: true }
      );
    }
  });
}

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * @param {string} title
 * @param {string} html
 * @param {{emailPreview?: boolean}} [options] When `emailPreview` is set the
 *   content is rendered inside a sandboxed iframe instead of being injected
 *   into this page, so email HTML and application CSS cannot affect each other.
 */
function showPopup(title, html, options) {
  const settings = options || {};

  let oldPopup = document.getElementById('custom-popup');
  if (oldPopup) oldPopup.remove();

  const popup = document.createElement('div');
  popup.id = 'custom-popup';
  popup.style.position = 'fixed';
  popup.style.top = '50%';
  popup.style.left = '50%';
  popup.style.transform = 'translate(-50%, -50%)';
  popup.style.background = '#fff';
  popup.style.zIndex = 10000;
  popup.style.border = '1px solid #333';
  popup.style.boxShadow = '0 2px 10px #0002';
  popup.style.boxSizing = 'border-box';
  popup.style.overflowY = 'auto';
  popup.style.maxHeight = '90vh';
  popup.style.minWidth = '280px';
  popup.style.width = '90vw';
  popup.style.maxWidth = title === 'Preview' ? '900px' : '95vw';
  popup.style.padding = '2.5em 3em 1em 1em';

  if (window.innerWidth < 400) {
    popup.style.padding = '2.5em 2em 0.5em 0.5em';
    popup.style.minWidth = '0';
  }

  const closeBtn = document.createElement('button');
  closeBtn.id = 'close-popup';
  closeBtn.innerHTML = '<i class="fa-solid fa-xmark"></i>';
  closeBtn.style.position = 'absolute';
  closeBtn.style.top = '10px';
  closeBtn.style.right = '10px';
  closeBtn.style.background = 'none';
  closeBtn.style.border = 'none';
  closeBtn.style.fontSize = '1.5em';
  closeBtn.style.cursor = 'pointer';
  closeBtn.style.color = '#333';
  closeBtn.onclick = () => {
    popup.remove();

    stopLogPopupAutoRefresh();
  };
  popup.appendChild(closeBtn);

  const h3 = document.createElement('h3');
  h3.textContent = title;
  h3.style.marginTop = '0';
  h3.style.marginRight = '0';
  popup.appendChild(h3);

  const contentDiv = document.createElement('div');
  contentDiv.id = 'popup-content';

  if (settings.emailPreview && window.HtmlPreview) {
    contentDiv.style.maxWidth = '900px';
    contentDiv.style.margin = '0 auto';
    contentDiv.style.background = '#ffffff';
    contentDiv.style.border = '1px solid #e2e5ea';
    contentDiv.style.borderRadius = '8px';
    contentDiv.style.boxShadow = '0 1px 4px #0001';
    contentDiv.style.display = 'block';

    // The frame scrolls internally, which is what lets wide desktop email
    // layouts scroll horizontally instead of being squeezed to the modal width.
    contentDiv.style.overflow = 'hidden';

    window.HtmlPreview.renderPreview(contentDiv, html, { height: '70vh' });
  } else {
    contentDiv.innerHTML = html;
  }

  popup.appendChild(contentDiv);
  document.body.appendChild(popup);
  popup.style.display = 'block';
}

const testRadio = document.getElementById('test');
const bulkRadio = document.getElementById('bulk');
const testRecpTextarea = document.getElementById('test-recp');

function updateModeUI() {
  const testStatusBox = document.getElementById('test-status');
  const bulkStatusBox = document.getElementById('bulk-status');

  if (testRadio && testRadio.checked) {
    if (testRecpTextarea) testRecpTextarea.disabled = false;

    if (testStatusBox) testStatusBox.style.display = 'block';
    if (bulkStatusBox) bulkStatusBox.style.display = 'none';

    updateLiveStatusForTestMode();
  } else if (bulkRadio && bulkRadio.checked) {
    if (testRecpTextarea) testRecpTextarea.disabled = true;

    if (testStatusBox) testStatusBox.style.display = 'none';
    if (bulkStatusBox) bulkStatusBox.style.display = 'block';

    updateLiveStatusFromFileIds();
  }
}
if (testRadio) testRadio.addEventListener('change', updateModeUI);
if (bulkRadio) bulkRadio.addEventListener('change', updateModeUI);

let campaignResumeChecked = false;

/**
 * Re-attaches the status poller to a campaign that is already in progress.
 *
 * Polling used to start only from the submit success path, so a page reload left
 * a live campaign with no poller at all: the counters froze at whatever
 * /files-stats last reported and never moved again. Operators reasonably read a
 * frozen panel as a stalled campaign and reached for a browser extension to
 * reload the page every few seconds — which restarted this same dead end while
 * consuming the rate-limit allowance that campaign submission needed.
 *
 * With this, the page recovers its own live view on load. The extension becomes
 * unnecessary rather than load-bearing.
 */
async function resumePollingIfCampaignActive() {
  if (campaignResumeChecked || isPolling) return;

  const fileIdsField = document.getElementById('file-ids');
  const raw = fileIdsField ? fileIdsField.value.trim() : '';
  if (!raw) return;

  const firstId = raw.split(',').map(id => id.trim()).filter(id => id)[0];
  if (!firstId) return;

  campaignResumeChecked = true;

  try {
    const res = await fetch(`/status?sessionId=${encodeURIComponent(firstId)}`);
    if (!res.ok) return;

    const data = await res.json();
    if (data.total === undefined) return;

    const settled = (data.sent || 0) + (data.failed || 0);

    // Only adopt campaigns with work left. A finished one must not restart
    // polling, or the page would poll a completed campaign indefinitely.
    if (!(data.total > 0 && settled < data.total)) return;

    sessionId = firstId;

    // A stopped campaign is adopted for display but not polled: nothing is going to
    // change until the operator submits again. Reported here so a reload cannot make
    // a stopped campaign look like a running one — and so the rate inputs come back
    // unlocked, ready for the new Limit and Interval.
    if (data.stopped) {
      window.currentSessionId = firstId;
      updateIntervalPopup(data);
      applyStoppedState(
        `⏹️ This campaign is stopped — ${data.sent || 0} sent, ${data.failed || 0} failed of ` +
        `${data.total}, ${Math.max(0, data.total - settled)} still pending. ` +
        'Change Limit/Interval and click Send Email to continue.'
      );
      return;
    }

    isSending = (data.sending || 0) > 0;
    setStopControlsVisible(true);
    // Locked only if work is genuinely in flight — same rule as the poller, so a
    // reload cannot leave the rate fields locked on an idle campaign.
    setRateInputsLocked(isSending);
    showError(describeCampaign(data));
    startStatusPolling();
  } catch (err) {
    console.error('Could not check for an in-progress campaign:', err);
  }
}

window.addEventListener('DOMContentLoaded', function () {
  updateModeUI();

  if (!testRadio.checked && !bulkRadio.checked) {
    testRadio.checked = true;
    updateModeUI();
  }

  resumePollingIfCampaignActive();

  // form-persistence.js restores the saved draft asynchronously from the server
  // and dispatches a synthetic change event, so #file-ids is often still empty
  // at DOMContentLoaded. This catches the value once it lands.
  const fileIdsField = document.getElementById('file-ids');
  if (fileIdsField) {
    fileIdsField.addEventListener('change', () => resumePollingIfCampaignActive());
  }
});

const refreshTestStatsBtn = document.getElementById('refresh-test-stats');
if (refreshTestStatsBtn) {
  refreshTestStatsBtn.addEventListener('click', refreshTestModeStats);
}

const infoBtn = document.getElementById('info');
if (infoBtn) {
  infoBtn.addEventListener('click', function () {
    showPopup('Info', `
      <b>Opterite - How to Use</b><br><br>
      <ul>
        <li><b>1. Upload Recipients:</b> Upload a file (.csv, .txt, .xlsx, .xls, .json) containing email addresses. Only valid emails are counted. The total is shown in the status panel. <b>If you select Test mode, file upload is disabled.</b></li>
        <li><b>2. Configure SMTP:</b> Enter your SMTP server details (host, port, user, password). This is required to send emails.</li>
        <li><b>3. Email Configuration:</b>
          <ul>
            <li><b>Test or Bulk:</b> Choose <b>Test</b> to send to test recipients (entered below), or <b>Bulk</b> to use the uploaded file. <b>Switching between Test and Bulk is allowed at any time. Bulk progress is preserved if you pause to send a test email.</b></li>
            <li><b>Test Recipients:</b> (for Test mode) Enter one or more email addresses, separated by commas. <b>This field is disabled in Bulk mode.</b></li>
            <li><b>Limit:</b> Set how many emails to send in one batch. For example, if you upload 100 emails and set limit to 25, only the first 25 will be sent. Next batch will start from the next email.</li>
            <li><b>From Name/Email:</b> Set the sender's name and email address.</li>
            <li><b>Subject:</b> Enter the email subject.</li>
            <li><b>File IDs:</b> (Mandatory for Bulk) Specify which uploaded files to use for recipients. You can specify multiple file IDs separated by commas. File IDs are required for bulk campaigns.</li>
            <li><b>Custom Headers:</b> (Optional) Add custom email headers in format "Header-Name: value". One header per line. Example:
              <ul>
                <li>X-Campaign-ID: summer2024</li>
                <li>X-Priority: high</li>
                <li>List-Unsubscribe: &lt;mailto:unsubscribe@example.com&gt;</li>
              </ul>
            </li>
            <li><b>Message Type:</b> Choose <b>Plain</b> for plain text or <b>HTML</b> for HTML emails.</li>
            <li><b>Message/HTML:</b> Enter your email content. Use the Preview button to see how it will look.</li>
          </ul>
        </li>
                    <li><b>4. Send Email:</b> Click <b>Send Email</b> to start sending. The system will send emails in batches as per your limit. No duplicate emails will be sent. <b>File IDs are mandatory for bulk campaigns.</b></li>
        <li><b>5. Live Status:</b> Separate status boxes for each mode:
          <ul>
            <li><b>Test Mode Status Box:</b> Shows statistics for test recipients entered in the form (green theme)</li>
            <li><b>Bulk Mode Status Box:</b> Shows statistics for emails from selected file IDs (blue theme)</li>
            <li><b>Mode Switching:</b> Only the relevant status box is shown based on selected mode</li>
            <li><b>Total:</b> Total emails (test recipients or valid emails from files)</li>
            <li><b>Queue:</b> Emails currently being processed</li>
            <li><b>Limit:</b> The batch size you set</li>
            <li><b>Live Sending:</b> Number of emails being sent in the current batch</li>
            <li><b>Pending:</b> Emails left to send (decreases as emails are sent)</li>
            <li><b>Total Sent:</b> Emails sent successfully</li>
            <li><b>Total Failed:</b> Emails that failed to send</li>
          </ul>
        </li>
        <li><b>6. File Management:</b>
          <ul>
            <li><b>File Storage:</b> All uploaded recipient files are stored on the server</li>
            <li><b>File Statistics:</b> Track total, valid, invalid, sent, failed, and pending emails for each file</li>
            <li><b>File IDs:</b> Each uploaded file gets a unique ID that you can copy and use in campaigns</li>
            <li><b>Download Options:</b> Download original file, sent emails, failed emails, or pending emails</li>
            <li><b>File Management:</b> Click "View Files" to see all uploaded files with detailed statistics</li>
            <li><b>Add to Form:</b> Use "Add to Form" button to easily add file IDs to your campaign</li>
            <li><b>Log Preservation:</b> Campaign logs are preserved even when files are deleted</li>
          </ul>
        </li>
        <li><b>7. Database Logs:</b>
          <ul>
            <li><b>MongoDB Storage:</b> All email logs are automatically saved in MongoDB database</li>
            <li><b>Persistent Logs:</b> Logs remain available even after server restarts</li>
            <li><b>Separate Test Logs:</b> Test mode creates separate logs with "test-" prefix</li>
                    <li><b>Log Management:</b> Click "Download Log" to see all available logs separated by mode (Test/Bulk) and choose which to download</li>
            <li><b>Log Count:</b> Button shows number of available logs (e.g., "Download Log (5)")</li>
          </ul>
        </li>
        <li><b>8. Delete Log:</b>
          <ul>
                    <li><b>Individual Delete:</b> Delete specific session logs directly</li>
        <li><b>Delete All:</b> Clear all stored logs at once</li>
        <li><b>Separated Sections:</b> Test mode and bulk mode logs are shown in separate sections</li>
            <li><b>Permanent Action:</b> Deleted logs cannot be recovered - download important data first!</li>
            <li><b>Log Count:</b> Button shows number of available logs (e.g., "Delete Log (5)")</li>
          </ul>
        </li>
        <li><b>9. Error Handling:</b> All errors (upload, send, status, log) are shown in the error box below the status panel. No page reloads are needed.</li>
        <li><b>10. Info & Preview:</b> Use the Info button (this popup) for help, and the Preview button to see your message before sending.</li>
      </ul>
      <b>🆕 New Features:</b><br>
      - <b>Mandatory File IDs:</b> File IDs are now required for bulk campaigns - upload files first, then add their IDs to campaigns<br>
      - <b>Live Status Updates:</b> Live status updates automatically when file IDs are added or removed from the form<br>
      - <b>Separate Status Boxes:</b> Test and bulk modes have completely separate live status boxes<br>
      - <b>File ID System:</b> Each uploaded file gets a unique ID that can be copied and reused in campaigns<br>
      - <b>Multi-File Campaigns:</b> Combine recipients from multiple uploaded files in a single campaign<br>
      - <b>File Storage System:</b> All uploaded recipient files are stored on the server with detailed tracking<br>
      - <b>Advanced File Management:</b> View all uploaded files with comprehensive statistics and download options<br>
      - <b>Multiple Download Types:</b> Download original files, sent emails, failed emails, or pending emails<br>
      - <b>MongoDB Database:</b> All email logs are automatically saved in MongoDB database<br>
      - <b>Persistent Storage:</b> Logs persist across server restarts and are stored securely<br>
      - <b>Advanced Log Management:</b> View, download, and delete logs with pagination<br>
      - <b>Direct Delete:</b> Delete operations work directly without confirmations<br>
      - <b>Real-time Updates:</b> Logs are updated in real-time as emails are sent<br>
      - <b>Log Preservation:</b> Campaign logs are preserved even when recipient files are deleted<br>
      - <b>Separate Test Logs:</b> Test mode creates separate logs with "test-" prefix for easy identification<br><br>
      <b>Tips:</b><br>
      - Use batching (limit) to avoid SMTP rate limits.<br>
      - Always check the status and error box for feedback.<br>
      - <b>Download important logs before deleting them!</b><br>
      - For best results, use a reliable SMTP server.<br>
      - Logs are stored in MongoDB database - they won't be lost when you restart the server.<br><br><br>
    `);
  });
}

const logBtn = document.getElementById('Download-log');
if (logBtn) {
  logBtn.addEventListener('click', function () {
    showLogSelectionPopup();
  });
}

async function updateLiveStatusForTestMode() {
  const testRecpField = document.getElementById('test-recp');
  if (!testRecpField) return;

  const testRecipients = testRecpField.value.trim();
  if (!testRecipients) {

    document.getElementById('test-sent').textContent = '0';
    document.getElementById('test-failed').textContent = '0';

    sessionId = null;
    return;
  }

  try {

    const recipientArray = testRecipients.split(',').map(email => email.trim()).filter(email => email);

    if (recipientArray.length === 0) {
      showError('⚠️ No valid test recipients found');
      return;
    }

    document.getElementById('test-sent').textContent = '0';
    document.getElementById('test-failed').textContent = '0';

    sessionId = null;

    showError(`✅ Test mode live status updated! Total test recipients: ${recipientArray.length}`);

  } catch (error) {
    console.error('Error updating test mode live status:', error);
    showError('❌ Failed to update test mode live status: ' + error.message);
  }
}

async function refreshTestModeStats() {
  try {

    if (!sessionId || !sessionId.startsWith('test-')) {
      showError('⚠️ No active test campaign to refresh');
      return;
    }

    const response = await fetch(`/status?sessionId=${sessionId}`);
    if (!response.ok) {
      throw new Error('Failed to fetch current test campaign status');
    }

    const data = await response.json();

    document.getElementById('test-sent').textContent = data.sent || 0;
    document.getElementById('test-failed').textContent = data.failed || 0;

    showError(`✅ Test mode stats refreshed! Current campaign - Sent: ${data.sent || 0}, Failed: ${data.failed || 0}`);

  } catch (error) {
    console.error('Error refreshing test mode stats:', error);
    showError('❌ Failed to refresh test mode stats: ' + error.message);
  }
}

async function updateLiveStatusFromFileIds() {
  const fileIdsField = document.getElementById('file-ids');
  if (!fileIdsField) return;

  const fileIds = fileIdsField.value.trim();
  if (!fileIds) {

    document.getElementById('bulk-total').textContent = '0';
    document.getElementById('bulk-queue').textContent = '0';
    document.getElementById('bulk-total-sending').textContent = '0';
    document.getElementById('bulk-pending').textContent = '0';
    document.getElementById('bulk-sent').textContent = '0';
    document.getElementById('bulk-failed').textContent = '0';

    sessionId = null;
    return;
  }

  try {

    const fileIdArray = fileIds.split(',').map(id => id.trim()).filter(id => id);

    const response = await fetch('/files-stats');
    if (!response.ok) {
      throw new Error('Failed to fetch file statistics');
    }

    const stats = await response.json();

    const filesResponse = await fetch('/files?limit=1000');
    if (!filesResponse.ok) {
      throw new Error('Failed to fetch files');
    }

    const filesData = await filesResponse.json();
    const selectedFiles = filesData.files.filter(file => fileIdArray.includes(file.sessionId));

    if (selectedFiles.length === 0) {
      showError('⚠️ No valid files found with the specified File IDs');
      return;
    }

    const totalValidEmails = selectedFiles.reduce((sum, file) => sum + file.validEmails, 0);
    const totalSentEmails = selectedFiles.reduce((sum, file) => sum + file.sentEmails, 0);
    const totalFailedEmails = selectedFiles.reduce((sum, file) => sum + file.failedEmails, 0);
    const totalPendingEmails = selectedFiles.reduce((sum, file) => sum + file.pendingEmails, 0);

    document.getElementById('bulk-total').textContent = totalValidEmails;
    document.getElementById('bulk-queue').textContent = '0';
    document.getElementById('bulk-total-sending').textContent = '0';
    document.getElementById('bulk-pending').textContent = totalPendingEmails;
    document.getElementById('bulk-sent').textContent = totalSentEmails;
    document.getElementById('bulk-failed').textContent = totalFailedEmails;

    window.selectedFileIds = fileIdArray;

    if (fileIdArray.length > 0) {
      sessionId = fileIdArray[0];
    }

    showError(`✅ Live status updated! Files: ${selectedFiles.length}, Total: ${totalValidEmails}, Sent: ${totalSentEmails}, Failed: ${totalFailedEmails}, Pending: ${totalPendingEmails}`);

  } catch (error) {
    console.error('Error updating live status:', error);
    showError('❌ Failed to update live status: ' + error.message);
  }
}

async function showLogSelectionPopup() {
  try {

    if (currentLogs.length === 0) {
      const data = await loadLogs();
      if (!data) return;
    }

    if (currentLogs.length === 0) {
      showError('No logs available in database.');
      return;
    }

    let popupContent = '<div style="margin-bottom: 15px;"><b>Select a log to download:</b></div>';

    popupContent += '<div style="margin-bottom: 15px; text-align: center;">';
    popupContent += '<button onclick="refreshLogPopup()" style="background: #007bff; color: white; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; margin-right: 10px;">';
    popupContent += '<i class="fa-solid fa-sync-alt"></i> Refresh Stats';
    popupContent += '</button>';
    popupContent += '</div>';

    if (totalPages > 1) {
      popupContent += '<div style="margin-bottom: 15px; text-align: center;">';
      if (currentPage > 1) {
        popupContent += `<button onclick="changeLogPage(${currentPage - 1})" style="margin-right: 10px; padding: 5px 10px;">Previous</button>`;
      }
      popupContent += `<span>Page ${currentPage} of ${totalPages}</span>`;
      if (currentPage < totalPages) {
        popupContent += `<button onclick="changeLogPage(${currentPage + 1})" style="margin-left: 10px; padding: 5px 10px;">Next</button>`;
      }
      popupContent += '</div>';
    }

    const testLogs = currentLogs.filter(log => log.sessionId.startsWith('test-'));
    const bulkLogs = currentLogs.filter(log => !log.sessionId.startsWith('test-'));

    popupContent += '<div style="display: flex; gap: 20px; margin-bottom: 20px;">';

    popupContent += '<div style="flex: 1;">';
    if (testLogs.length > 0) {
      popupContent += '<div style="background: #e8f5e8; padding: 10px; border-radius: 5px; margin-bottom: 10px; border-left: 4px solid #28a745;">';
      popupContent += '<h3 style="margin: 0; color: #28a745;"><i class="fa-solid fa-flask"></i> Test Mode Logs</h3>';
      popupContent += '</div>';

      testLogs.forEach((log) => {
        const date = new Date(log.createdAt).toLocaleString();
        const status = log.status === 'in_progress' ? 'In Progress' : log.status === 'completed' ? 'Completed' : 'Failed';
        const statusColor = log.status === 'in_progress' ? 'orange' : log.status === 'completed' ? 'green' : 'red';

        popupContent += `
          <div style="border: 1px solid #ddd; margin: 5px 0; padding: 10px; border-radius: 5px; cursor: pointer; background: #f8fff9;"
               onclick="downloadSelectedLog('${log.sessionId}')">
            <div style="font-weight: bold;">Session: ${log.sessionId}</div>
            <div style="font-size: 0.9em; color: #666;">Date: ${date}</div>
            <div style="font-size: 0.9em;">
              Subject: ${log.subject || 'N/A'}
            </div>
            <div style="font-size: 0.9em;">
              Total: ${log.totalRecipients} | Sent: ${log.sentCount} | Failed: ${log.failedCount} | Pending: ${log.pendingCount}
            </div>
            <div style="color: ${statusColor}; font-weight: bold;">Status: ${status}</div>
          </div>
        `;
      });
    } else {
      popupContent += '<div style="background: #e8f5e8; padding: 10px; border-radius: 5px; margin-bottom: 10px; border-left: 4px solid #28a745;">';
      popupContent += '<h3 style="margin: 0; color: #28a745;"><i class="fa-solid fa-flask"></i> Test Mode Logs (0)</h3>';
      popupContent += '</div>';
      popupContent += '<div style="border: 1px solid #ddd; margin: 5px 0; padding: 20px; border-radius: 5px; background: #f8fff9; text-align: center; color: #666;">';
      popupContent += '<i class="fa-solid fa-inbox"></i> No test logs available';
      popupContent += '</div>';
    }
    popupContent += '</div>';

    popupContent += '<div style="flex: 1;">';
    if (bulkLogs.length > 0) {
      popupContent += '<div style="background: #e8f2ff; padding: 10px; border-radius: 5px; margin-bottom: 10px; border-left: 4px solid #007bff;">';
      popupContent += '<h3 style="margin: 0; color: #007bff;"><i class="fa-solid fa-chart-line"></i> Bulk Mode Logs</h3>';
      popupContent += '</div>';

      bulkLogs.forEach((log) => {
        const date = new Date(log.createdAt).toLocaleString();
        const status = log.status === 'in_progress' ? 'In Progress' : log.status === 'completed' ? 'Completed' : 'Failed';
        const statusColor = log.status === 'in_progress' ? 'orange' : log.status === 'completed' ? 'green' : 'red';

        popupContent += `
          <div style="border: 1px solid #ddd; margin: 5px 0; padding: 10px; border-radius: 5px; cursor: pointer; background: #f8fbff;"
               onclick="downloadSelectedLog('${log.sessionId}')">
            <div style="font-weight: bold;">Session: ${log.sessionId}</div>
            <div style="font-size: 0.9em; color: #666;">Date: ${date}</div>
            <div style="font-size: 0.9em;">
              Subject: ${log.subject || 'N/A'}
            </div>
            <div style="font-size: 0.9em;">
              Total: ${log.totalRecipients} | Sent: ${log.sentCount} | Failed: ${log.failedCount} | Pending: ${log.pendingCount}
            </div>
            <div style="color: ${statusColor}; font-weight: bold;">Status: ${status}</div>
          </div>
        `;
      });
    } else {
      popupContent += '<div style="background: #e8f2ff; padding: 10px; border-radius: 5px; margin-bottom: 10px; border-left: 4px solid #007bff;">';
      popupContent += '<h3 style="margin: 0; color: #007bff;"><i class="fa-solid fa-chart-line"></i> Bulk Mode Logs (0)</h3>';
      popupContent += '</div>';
      popupContent += '<div style="border: 1px solid #ddd; margin: 5px 0; padding: 20px; border-radius: 5px; background: #f8fbff; text-align: center; color: #666;">';
      popupContent += '<i class="fa-solid fa-inbox"></i> No bulk logs available';
      popupContent += '</div>';
    }
    popupContent += '</div>';

    popupContent += '</div>';

    popupContent += '</div>';

    showPopup('Download Log', popupContent);

    startLogPopupAutoRefresh();
  } catch (error) {
    showError('Failed to load logs: ' + error.message);
  }
}

async function changeLogPage(page) {
  await loadLogs(page);
  showLogSelectionPopup();
}

async function refreshLogPopup() {
  try {
    await loadLogs(currentPage);
    showLogSelectionPopup();
  } catch (error) {
    console.error('Error refreshing log popup:', error);
  }
}

let logPopupRefreshInterval = null;

function startLogPopupAutoRefresh() {
  if (logPopupRefreshInterval) {
    clearTimeout(logPopupRefreshInterval);
  }

  const runRefresh = async () => {
    if (!logPopupRefreshInterval) return;

    if (document.hidden) {
      logPopupRefreshInterval = setTimeout(runRefresh, 5000);
      return;
    }

    const popup = document.getElementById('custom-popup');
    if (popup && popup.querySelector('div[style*="Select a log to download"]')) {
      await refreshLogPopup();

      logPopupRefreshInterval = setTimeout(runRefresh, 10000);
    } else {
      stopLogPopupAutoRefresh();
    }
  };

  logPopupRefreshInterval = setTimeout(runRefresh, 5000);
}

function stopLogPopupAutoRefresh() {
  if (logPopupRefreshInterval) {
    clearTimeout(logPopupRefreshInterval);
    logPopupRefreshInterval = null;
  }
}

async function downloadSelectedLog(sessionId) {
  try {
    const response = await fetch(`/logs/${sessionId}/download`);
    if (!response.ok) {
      throw new Error('Failed to download log');
    }

    const blob = await response.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.style.display = 'none';
    a.href = url;
    a.download = `emaillog-${sessionId}.csv`;
    document.body.appendChild(a);
    a.click();
    window.URL.revokeObjectURL(url);
    a.remove();
    showError('');

    const popup = document.getElementById('custom-popup');
    if (popup) popup.remove();
  } catch (error) {
    showError('Log download failed: ' + error.message);
  }
}

const deleteBtn = document.getElementById('delete-log');
if (deleteBtn) {
  deleteBtn.addEventListener('click', function () {
    showDeleteLogPopup();
  });
}

async function showDeleteLogPopup() {
  try {

    if (currentLogs.length === 0) {
      const data = await loadLogs();
      if (!data) return;
    }

    let popupContent = '<div style="margin-bottom: 15px;"><b>Select logs to delete:</b></div>';

    if (totalPages > 1) {
      popupContent += '<div style="margin-bottom: 15px; text-align: center;">';
      if (currentPage > 1) {
        popupContent += `<button onclick="changeDeletePage(${currentPage - 1})" style="margin-right: 10px; padding: 5px 10px;">Previous</button>`;
      }
      popupContent += `<span>Page ${currentPage} of ${totalPages}</span>`;
      if (currentPage < totalPages) {
        popupContent += `<button onclick="changeDeletePage(${currentPage + 1})" style="margin-left: 10px; padding: 5px 10px;">Next</button>`;
      }
      popupContent += '</div>';
    }

    const testLogs = currentLogs.filter(log => log.sessionId.startsWith('test-'));
    const bulkLogs = currentLogs.filter(log => !log.sessionId.startsWith('test-'));

    popupContent += '<div style="display: flex; gap: 20px; margin-bottom: 20px;">';

    popupContent += '<div style="flex: 1;">';
    if (testLogs.length > 0) {
      popupContent += '<div style="background: #e8f5e8; padding: 10px; border-radius: 5px; margin-bottom: 10px; border-left: 4px solid #28a745;">';
      popupContent += '<h3 style="margin: 0; color: #28a745;"><i class="fa-solid fa-flask"></i> Test Mode Logs</h3>';
      popupContent += '</div>';

      testLogs.forEach((log) => {
        const date = new Date(log.createdAt).toLocaleString();
        const status = log.status === 'in_progress' ? 'In Progress' : log.status === 'completed' ? 'Completed' : 'Failed';
        const statusColor = log.status === 'in_progress' ? 'orange' : log.status === 'completed' ? 'green' : 'red';

        popupContent += `
          <div style="border: 1px solid #ddd; margin: 5px 0; padding: 10px; border-radius: 5px; background: #f8fff9;">
            <div style="display: flex; align-items: center; justify-content: space-between;">
              <div style="flex: 1;">
                <div style="font-weight: bold;">Session: ${log.sessionId}</div>
                <div style="font-size: 0.9em; color: #666;">Date: ${date}</div>
                <div style="font-size: 0.9em;">
                  Subject: ${log.subject || 'N/A'}
                </div>
                <div style="font-size: 0.9em;">
                  Total: ${log.totalRecipients} | Sent: ${log.sentCount} | Failed: ${log.failedCount} | Pending: ${log.pendingCount}
                </div>
                <div style="color: ${statusColor}; font-weight: bold;">Status: ${status}</div>
              </div>
              <button onclick="deleteSelectedLog('${log.sessionId}')"
                      style="background: #dc3545; color: white; border: none; padding: 5px 10px; border-radius: 3px; cursor: pointer; margin-left: 10px;">
                <i class="fa-solid fa-trash"></i> Delete
              </button>
            </div>
          </div>
        `;
      });
    } else {
      popupContent += '<div style="background: #e8f5e8; padding: 10px; border-radius: 5px; margin-bottom: 10px; border-left: 4px solid #28a745;">';
      popupContent += '<h3 style="margin: 0; color: #28a745;"><i class="fa-solid fa-flask"></i> Test Mode Logs (0)</h3>';
      popupContent += '</div>';
      popupContent += '<div style="border: 1px solid #ddd; margin: 5px 0; padding: 20px; border-radius: 5px; background: #f8fff9; text-align: center; color: #666;">';
      popupContent += '<i class="fa-solid fa-inbox"></i> No test logs available';
      popupContent += '</div>';
    }
    popupContent += '</div>';

    popupContent += '<div style="flex: 1;">';
    if (bulkLogs.length > 0) {
      popupContent += '<div style="background: #e8f2ff; padding: 10px; border-radius: 5px; margin-bottom: 10px; border-left: 4px solid #007bff;">';
      popupContent += '<h3 style="margin: 0; color: #007bff;"><i class="fa-solid fa-chart-line"></i> Bulk Mode Logs</h3>';
      popupContent += '</div>';

      bulkLogs.forEach((log) => {
        const date = new Date(log.createdAt).toLocaleString();
        const status = log.status === 'in_progress' ? 'In Progress' : log.status === 'completed' ? 'Completed' : 'Failed';
        const statusColor = log.status === 'in_progress' ? 'orange' : log.status === 'completed' ? 'green' : 'red';

        popupContent += `
          <div style="border: 1px solid #ddd; margin: 5px 0; padding: 10px; border-radius: 5px; background: #f8fbff;">
        <div style="display: flex; align-items: center; justify-content: space-between;">
          <div style="flex: 1;">
            <div style="font-weight: bold;">Session: ${log.sessionId}</div>
            <div style="font-size: 0.9em; color: #666;">Date: ${date}</div>
            <div style="font-size: 0.9em;">
                  Subject: ${log.subject || 'N/A'}
                </div>
                <div style="font-size: 0.9em;">
                  Total: ${log.totalRecipients} | Sent: ${log.sentCount} | Failed: ${log.failedCount} | Pending: ${log.pendingCount}
            </div>
            <div style="color: ${statusColor}; font-weight: bold;">Status: ${status}</div>
          </div>
          <button onclick="deleteSelectedLog('${log.sessionId}')"
                  style="background: #dc3545; color: white; border: none; padding: 5px 10px; border-radius: 3px; cursor: pointer; margin-left: 10px;">
            <i class="fa-solid fa-trash"></i> Delete
          </button>
        </div>
      </div>
    `;
      });
    } else {
      popupContent += '<div style="background: #e8f2ff; padding: 10px; border-radius: 5px; margin-bottom: 10px; border-left: 4px solid #007bff;">';
      popupContent += '<h3 style="margin: 0; color: #007bff;"><i class="fa-solid fa-chart-line"></i> Bulk Mode Logs (0)</h3>';
      popupContent += '</div>';
      popupContent += '<div style="border: 1px solid #ddd; margin: 5px 0; padding: 20px; border-radius: 5px; background: #f8fbff; text-align: center; color: #666;">';
      popupContent += '<i class="fa-solid fa-inbox"></i> No bulk logs available';
      popupContent += '</div>';
    }
    popupContent += '</div>';

    popupContent += '</div>';

    popupContent += '</div>';
    popupContent += '<div style="margin-top: 15px; text-align: center;">';
    popupContent += '<button onclick="deleteAllLogs()" style="background: #dc3545; color: white; border: none; padding: 10px 20px; border-radius: 5px; cursor: pointer;">';
    popupContent += '<i class="fa-solid fa-trash"></i> Delete All Logs';
    popupContent += '</button>';
    popupContent += '</div>';

    showPopup('Delete Logs', popupContent);
  } catch (error) {
    showError('Failed to load logs: ' + error.message);
  }
}

async function changeDeletePage(page) {
  await loadLogs(page);
  showDeleteLogPopup();
}

async function deleteSelectedLog(sessionId) {
  try {
    const response = await fetch(`/logs/${sessionId}`, {
      method: 'DELETE'
    });

    if (!response.ok) {
      throw new Error('Failed to delete log');
    }

    showError(`✅ Log for session ${sessionId} deleted successfully.`);

    await loadLogs(currentPage);

    const popup = document.getElementById('custom-popup');
    if (popup) popup.remove();
  } catch (error) {
    showError('Delete failed: ' + error.message);
  }
}

async function deleteAllLogs() {
  try {
    const response = await fetch('/logs', {
      method: 'DELETE'
    });

    if (!response.ok) {
      throw new Error('Failed to delete all logs');
    }

    const result = await response.json();
    showError(`✅ ${result.message}`);

    await loadLogs(1);

    const popup = document.getElementById('custom-popup');
    if (popup) popup.remove();
  } catch (error) {
    showError('Delete all failed: ' + error.message);
  }
}

window.addEventListener('DOMContentLoaded', function () {
  const passInput = document.getElementById('smtp-pass');
  const toggleBtn = document.getElementById('toggle-smtp-pass');
  const eyeIcon = document.getElementById('smtp-pass-eye');
  if (passInput && toggleBtn && eyeIcon) {
    toggleBtn.addEventListener('click', function () {
      if (passInput.type === 'password') {
        passInput.type = 'text';
        eyeIcon.classList.remove('fa-eye');
        eyeIcon.classList.add('fa-eye-slash');
      } else {
        passInput.type = 'password';
        eyeIcon.classList.remove('fa-eye-slash');
        eyeIcon.classList.add('fa-eye');
      }
    });
  }

  const fileIdsField = document.getElementById('file-ids');
  if (fileIdsField) {

    let debounceTimer;
    fileIdsField.addEventListener('input', function () {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        updateLiveStatusFromFileIds();
      }, 500);
    });

    fileIdsField.addEventListener('blur', function () {
      clearTimeout(debounceTimer);
      updateLiveStatusFromFileIds();
    });
  }

  const testRecpField = document.getElementById('test-recp');
  if (testRecpField) {

    let testDebounceTimer;
    testRecpField.addEventListener('input', function () {
      clearTimeout(testDebounceTimer);
      testDebounceTimer = setTimeout(() => {
        updateLiveStatusForTestMode();
      }, 500);
    });

    testRecpField.addEventListener('blur', function () {
      clearTimeout(testDebounceTimer);
      updateLiveStatusForTestMode();
    });
  }

  loadLogs();
});
