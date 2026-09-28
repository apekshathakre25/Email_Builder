/**
 * Makes a tab wait its turn before sending, and start automatically when it comes.
 *
 * The ordering is NOT decided here. The server owns it: /campaign-lane/claim puts this
 * campaign in the operator's queue, GET /campaign-lane reports whether it is cleared,
 * and /campaign-lane/start is the single gate that lets a submission through. This
 * file only polls and then performs the submission the operator already configured.
 *
 * Why the browser still submits, rather than the server starting the campaign itself:
 * the payload — message body, headers, subject, selected files, rate — lives in this
 * tab's form and its sessionStorage draft. Having the server start a waiting campaign
 * would mean persisting all of that server-side, which is a much larger change and
 * duplicates /send-email. The consequence is the one limitation worth knowing: a
 * waiting tab has to stay open. It is stated in the UI.
 *
 * Interaction with the existing submit path: recipents-upload.js calls
 * `CampaignSequencer.requestSend()` and only proceeds when it resolves true. Nothing
 * about how the form is built, validated or posted changes.
 */
(function () {
  'use strict';

  var POLL_MS = 2000;

  /**
   * Marks that THIS tab is waiting to send THIS campaign.
   *
   * sessionStorage is exactly the right scope: it survives a reload and dies with the
   * tab. So the marker is present after a refresh — the wait resumes and the campaign
   * still sends — and absent once the tab is closed, which is why a closed tab's
   * campaign is never revived. The server reaches the same conclusion independently
   * from the missing heartbeat; this is what makes the surviving tab pick its wait
   * back up rather than needing the operator to press Send again.
   */
  var INTENT_KEY = 'opterite:lane-waiting';

  function rememberIntent(campaignId) {
    try {
      sessionStorage.setItem(INTENT_KEY, campaignId);
    } catch (err) {
      // Private mode or blocked storage. The wait still works in this page's lifetime;
      // it just will not survive a reload.
    }
  }

  function forgetIntent() {
    try {
      sessionStorage.removeItem(INTENT_KEY);
    } catch (err) {
      /* nothing to clean up */
    }
  }

  function rememberedIntent() {
    try {
      return sessionStorage.getItem(INTENT_KEY);
    } catch (err) {
      return null;
    }
  }

  /** Backoff used only when the lane endpoint itself is unreachable. */
  var RETRY_MS = 5000;
  var MAX_CONSECUTIVE_ERRORS = 60;

  var state = {
    campaignId: null,
    laneState: null,
    position: 0,
    polling: false,
    timer: null,
    errors: 0,
    /** Resolver for the requestSend() promise the submit handler is awaiting. */
    pendingRelease: null,
    /**
     * Whether THIS tab is the one that started the campaign now sending.
     *
     * Distinguishes the two reasons a submit can arrive for a SENDING campaign. A
     * second tab, or a stray double-click, must be refused. But this tab submitting
     * again is the existing batch-continuation behaviour — an unpaced campaign sends
     * `limit` recipients per submission, and the automatic retry after an HTTP 429
     * re-submits too — so it has to be allowed or this feature would break sending
     * the remainder of a large campaign.
     */
    ownedSending: false,
    /** Guards the one-shot re-claim after being dropped for a missed heartbeat. */
    reclaimed: false
  };

  function byId(id) {
    return document.getElementById(id);
  }

  /**
   * The status line. Created on demand and inserted above the form's button row so it
   * sits where the operator is already looking when they press Send.
   */
  function banner() {
    var existing = byId('campaign-lane-banner');
    if (existing) return existing;

    var el = document.createElement('p');
    el.id = 'campaign-lane-banner';
    el.className = 'field__hint';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.hidden = true;

    var anchor = byId('send-email');
    var row = anchor && anchor.parentNode;
    if (row && row.parentNode) row.parentNode.insertBefore(el, row);
    else if (document.getElementById('email-form')) document.getElementById('email-form').appendChild(el);

    return el;
  }

  function say(text) {
    var el = banner();
    if (!el) return;

    if (!text) {
      el.hidden = true;
      el.textContent = '';
      return;
    }

    el.hidden = false;
    el.textContent = text;
  }

  /** Mirrors the wait onto the Send button, so it is obvious why nothing happened. */
  function setSendButtonWaiting(waiting, label) {
    var btn = byId('send-email');
    if (!btn) return;

    if (waiting) {
      if (!btn.dataset.laneOriginalHtml) btn.dataset.laneOriginalHtml = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = '<i class="fa-solid fa-hourglass-half"></i> ' + (label || 'Waiting…');
      return;
    }

    btn.disabled = false;
    if (btn.dataset.laneOriginalHtml) {
      btn.innerHTML = btn.dataset.laneOriginalHtml;
      delete btn.dataset.laneOriginalHtml;
    }
  }

  /**
   * The campaign's identity, matching what /send-email will use as its sessionId:
   * the first selected file id for a bulk campaign.
   */
  function currentCampaignId() {
    var field = byId('file-ids');
    var raw = field ? String(field.value || '').trim() : '';
    if (!raw) return null;

    var ids = raw.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    return ids.length ? ids[0] : null;
  }

  function isBulkMode() {
    var bulk = byId('bulk');
    return Boolean(bulk && bulk.checked);
  }

  async function post(path, body) {
    var res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    });
    var payload = null;
    try { payload = await res.json(); } catch (err) { payload = null; }
    return { ok: res.ok, status: res.status, payload: payload };
  }

  async function getLane(campaignId) {
    var url = '/campaign-lane' + (campaignId ? '?campaignId=' + encodeURIComponent(campaignId) : '');
    var res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  function stopPolling() {
    state.polling = false;
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
  }

  /**
   * Waits for this campaign to reach the head of the lane, then hands control back.
   *
   * Recovers on its own after a refresh: `claim` is idempotent, so a reloaded tab is
   * told the position it already holds and resumes polling from there.
   */
  function pollUntilCleared() {
    if (state.polling) return;
    state.polling = true;

    var tick = async function () {
      if (!state.polling) return;

      try {
        var lane = await getLane(state.campaignId);
        state.errors = 0;
        state.laneState = lane.state;
        state.position = lane.position;

        if (lane.cleared) {
          // Take the start gate here rather than letting the caller race another tab
          // between this poll and its submission.
          var started = await post('/campaign-lane/start', { campaignId: state.campaignId });
          if (!started.ok) {
            say((started.payload && started.payload.reason) || 'Another campaign started first.');
            setSendButtonWaiting(false);
            stopPolling();
            release(false);
            return;
          }

          state.ownedSending = true;
          forgetIntent();
          stopPolling();
          say('Starting campaign…');
          setSendButtonWaiting(false);
          release(true);
          return;
        }

        if (lane.state === 'SENDING') {
          // Already running — this tab reloaded mid-campaign. Not a release: the
          // campaign is in the workers' hands and must not be submitted again.
          forgetIntent();
          stopPolling();
          say('');
          setSendButtonWaiting(false);
          release(false);
          return;
        }

        // Dropped for going quiet, but this tab is plainly still here — it is the one
        // asking. A suspended laptop, a long GC pause or a slow network can all exceed
        // the heartbeat window without the tab having gone anywhere, so it takes its
        // place back instead of reporting the campaign dead. Guarded to one attempt so
        // a persistently failing re-claim cannot loop.
        if (lane.state === 'CANCELLED' && lane.abandoned && !state.reclaimed) {
          state.reclaimed = true;
          var back = await post('/campaign-lane/claim', { campaignId: state.campaignId });
          if (back.ok && back.payload && back.payload.state !== 'CANCELLED') {
            say('Reconnected to the campaign queue…');
            state.timer = setTimeout(tick, POLL_MS);
            return;
          }
        }

        if (
          lane.state === 'CANCELLED' || lane.state === 'COMPLETED' ||
          lane.state === 'FAILED' || lane.state === 'PAUSED'
        ) {
          forgetIntent();
          stopPolling();
          say(lane.state === 'CANCELLED'
            ? 'This campaign is no longer queued. Press Send Email to queue it again.'
            : '');
          setSendButtonWaiting(false);
          release(false);
          return;
        }

        rememberIntent(state.campaignId);
        var ahead = Math.max(0, (lane.position || 1) - 1);
        say(
          'Waiting for the previous campaign to complete…' +
          (ahead > 0 ? ' ' + ahead + ' campaign(s) ahead of this one.' : '')
        );
        setSendButtonWaiting(true, 'Waiting for previous campaign…');

        state.timer = setTimeout(tick, POLL_MS);
      } catch (err) {
        // A dropped connection must not abandon the wait. The lane lives on the
        // server, so reconnecting simply resumes where it left off.
        state.errors += 1;

        if (state.errors >= MAX_CONSECUTIVE_ERRORS) {
          stopPolling();
          say('Could not reach the server to check the campaign queue. Press Send Email to try again.');
          setSendButtonWaiting(false);
          release(false);
          return;
        }

        say('Reconnecting to the campaign queue… (attempt ' + state.errors + ')');
        state.timer = setTimeout(tick, RETRY_MS);
      }
    };

    tick();
  }

  function release(cleared) {
    var resolver = state.pendingRelease;
    state.pendingRelease = null;
    if (resolver) resolver(cleared);
  }

  /**
   * Called by the submit handler. Resolves true when this tab may post /send-email.
   *
   * Test-mode sends bypass the lane entirely: they are a handful of addresses used to
   * check inbox placement, they are not what the sequencing exists to serialise, and
   * making an operator queue behind a 70,000-recipient campaign to send one test
   * would be a regression in its own right.
   */
  async function requestSend() {
    if (!isBulkMode()) return true;

    var campaignId = currentCampaignId();
    if (!campaignId) return true; // no file ids; the submit handler reports that itself

    state.campaignId = campaignId;

    var claimed;
    try {
      claimed = await post('/campaign-lane/claim', {
        campaignId: campaignId,
        total: Number((byId('limit') || {}).value) || 0
      });
    } catch (err) {
      // The sequencer must not be able to prevent sending outright. If the lane is
      // unreachable the operator keeps the behaviour they had before this feature.
      console.warn('Campaign queue unreachable; sending without sequencing:', err.message);
      return true;
    }

    if (!claimed.ok || !claimed.payload) {
      console.warn('Campaign queue refused the claim; sending without sequencing.');
      return true;
    }

    var lane = claimed.payload;
    state.laneState = lane.state;
    state.position = lane.position;

    if (lane.state === 'SENDING') {
      // Ours: this is the next batch of a campaign already under way, or the retry
      // after a 429. Let it through — refusing would strand the remaining recipients.
      if (state.ownedSending) return true;

      say('This campaign is already sending in another tab.');
      return false;
    }

    // A campaign paused by Limit to Send is a fresh claim, not a continuation: its turn
    // ended and the lane may now be held by another tab. Clearing this lets the normal
    // claim path below decide whether it sends now or queues.
    if (lane.state === 'PAUSED') state.ownedSending = false;

    if (lane.cleared) {
      var started = await post('/campaign-lane/start', { campaignId: campaignId });
      if (!started.ok) {
        // Another tab or another click got there first.
        say((started.payload && started.payload.reason) || 'This campaign is already starting.');
        return false;
      }
      state.ownedSending = true;
      say('');
      return true;
    }

    // Behind something. Wait, then submit automatically when released.
    return new Promise(function (resolve) {
      state.pendingRelease = resolve;
      pollUntilCleared();
    });
  }

  /**
   * Re-establishes a wait after a reload.
   *
   * A tab refreshed while waiting has lost its in-memory promise but not its place:
   * the lane is server-side. Re-claiming reports the position it still holds, and if
   * it is still behind something the wait — and the automatic start — resume.
   */
  async function resumeAfterReload() {
    var campaignId = currentCampaignId();
    if (!campaignId) return;

    // Only a tab that was waiting before the reload resumes. Without this marker a
    // freshly opened tab on the same recipient file would queue itself and start
    // sending without the operator ever pressing Send.
    if (rememberedIntent() !== campaignId) return;

    // Re-claim rather than just poll. A slow reload can exceed the heartbeat window,
    // in which case the server has already dropped this campaign as abandoned;
    // claiming puts it back in line. Claiming is idempotent, so in the normal case it
    // simply returns the place it still holds.
    var reclaimed;
    try {
      reclaimed = await post('/campaign-lane/claim', { campaignId: campaignId });
    } catch (err) {
      return; // nothing to recover from; the operator can press Send
    }

    var lane = reclaimed && reclaimed.payload;
    if (!lane || !lane.state) return;

    if (lane.state === 'SENDING') {
      // Reloaded mid-send. The workers own it; do not submit again.
      forgetIntent();
      return;
    }

    if (lane.state === 'COMPLETED' || lane.state === 'FAILED') {
      forgetIntent();
      return;
    }

    state.campaignId = campaignId;
    state.laneState = lane.state;
    state.position = lane.position;

    // Rebuild the promise the submit handler would have been holding, so that when
    // the lane frees this tab submits on its own exactly as it would have.
    state.pendingRelease = function (cleared) {
      if (!cleared) return;
      var form = byId('email-form');
      if (form && typeof form.requestSubmit === 'function') form.requestSubmit();
    };

    // Already at the head: the campaign ahead finished during the reload.
    if (lane.cleared) {
      var started = await post('/campaign-lane/start', { campaignId: campaignId });
      if (started.ok) {
        state.ownedSending = true;
        forgetIntent();
        var form = byId('email-form');
        if (form && typeof form.requestSubmit === 'function') form.requestSubmit();
      }
      return;
    }

    pollUntilCleared();
  }

  /**
   * Gives up a place in the lane. Only ever called for an explicit cancel.
   *
   * Deliberately NOT bound to `pagehide`. That event fires identically on a refresh and
   * on a close, so sending a "leave" beacon from it cancelled the campaign of any tab
   * that was merely reloading — and because a cancelled slot refuses to be re-queued,
   * the campaign could not be restarted afterwards. A closed tab is now recognised by
   * the absence of its heartbeat instead, which distinguishes the two cases correctly.
   */
  function leaveIfWaiting() {
    if (!state.campaignId) return;
    if (state.laneState !== 'WAITING') return;

    try {
      // keepalive so the request survives the page going away.
      fetch('/campaign-lane/leave', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ campaignId: state.campaignId }),
        keepalive: true
      });
    } catch (err) {
      // The claim's TTL clears it eventually either way.
    }
  }

  window.CampaignSequencer = {
    requestSend: requestSend,
    /** Told by the submit handler once /send-email has been accepted. */
    markSubmitted: function () {
      state.laneState = 'SENDING';
      state.ownedSending = true;
      say('');
      setSendButtonWaiting(false);
    },
    cancelWait: function () {
      stopPolling();
      release(false);
      leaveIfWaiting();
      forgetIntent();
      say('');
      setSendButtonWaiting(false);
    },
    state: function () {
      return { campaignId: state.campaignId, laneState: state.laneState, position: state.position };
    }
  };

  window.addEventListener('DOMContentLoaded', function () {
    resumeAfterReload();
  });

  // No `pagehide` handler on purpose. See leaveIfWaiting(): that event cannot tell a
  // refresh from a close, so liveness is the heartbeat in pollUntilCleared() instead.
})();
