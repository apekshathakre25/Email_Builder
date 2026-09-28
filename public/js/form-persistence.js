/**
 * Persists the campaign form on /interface so a refresh does not clear it.
 *
 * The draft lives in sessionStorage, which is per browser tab. That is the whole
 * point: the form is temporary UI state, and the previous implementation kept it
 * in a single MongoDB document keyed on the login email, so every tab read and
 * wrote the same row. Two tabs could not hold different values — editing one and
 * then reloading another showed the second tab the first one's data, because
 * there was only ever one record.
 *
 * sessionStorage has exactly the semantics this form needs. It survives reloads
 * and session restore, it is copied into a duplicated tab (so the duplicate opens
 * showing the source tab's data), and the two copies are independent from that
 * moment on — a write in one is not visible in the other. No draft ids, no
 * cross-tab coordination and no database writes are required to get that.
 *
 * WHAT IS NOT STORED HERE: the SMTP password. It stays server-side, encrypted at
 * rest (utils/credentialCipher) in the EmailConfig collection, and is write-only
 * from the browser's point of view — sent when the operator types one, never sent
 * back. After a refresh the field is empty and /send-email substitutes the stored
 * credential. Putting it in sessionStorage would mean a plaintext SMTP password
 * sitting in browser storage, so the password is the one field that still talks to
 * the server.
 *
 * The stored draft is stamped with the logged-in email and discarded when it does
 * not match. sessionStorage is scoped to the tab, not to the account, and it
 * outlives a logout in that tab — without the stamp, the next operator to sign in
 * on the same tab would inherit the previous one's SMTP host and user.
 */
(function () {
  'use strict';

  /**
   * Short because the write is synchronous and local; this only exists to avoid
   * re-serialising a large HTML message body on every keystroke.
   */
  var SAVE_DEBOUNCE_MS = 250;

  var STORAGE_KEY = 'opterite:campaign-form';

  /** Bumped when the stored shape changes, so old payloads are dropped, not misread. */
  var SCHEMA_VERSION = 1;

  /** Only the SMTP password is exchanged with the server now. */
  var CREDENTIAL_ENDPOINT = '/email-config';

  /** Form control id -> stored key. */
  var TEXT_FIELDS = [
    { id: 'smtp-host', key: 'smtpHost' },
    { id: 'smtp-port', key: 'smtpPort' },
    { id: 'smtp-user', key: 'smtpUser' },
    { id: 'custom-headers', key: 'customHeaders' },
    { id: 'smtp-from-email', key: 'fromEmail' },
    { id: 'subject', key: 'subject' },
    { id: 'smtp-from-name', key: 'fromName' },
    { id: 'test-recp', key: 'testRecipients' },
    { id: 'message', key: 'message' },
    { id: 'file-ids', key: 'fileIds' },
    { id: 'custom-message-id', key: 'customMessageId' },
    { id: 'limit', key: 'limit' },
    { id: 'limit-to-send', key: 'limitToSend' },
    { id: 'interval-seconds', key: 'intervalSeconds' }
  ];

  /**
   * Radio groups, as value -> control id. `auto-imap-test` is intentionally not
   * persisted: it is not free-standing configuration but derived state that
   * imap-checker.js enables only in Test mode and only once IMAP accounts and
   * credentials exist, and it clears itself whenever the mode changes.
   */
  var RADIO_GROUPS = [
    { key: 'testBulk', options: { Bulk: 'bulk', Test: 'test' } },
    { key: 'messageType', options: { Plain: 'plain', HTML: 'html' } }
  ];

  /** Browser-storage keys from the original localStorage-based implementation. */
  var LEGACY_LOCAL_KEYS = ['smtpHost', 'smtpPort', 'smtpUser', 'smtpPass'];

  var saveTimer = null;
  var passwordTimer = null;
  var restoring = false;

  /**
   * Whether the operator has actually interacted with the password field.
   *
   * The browser's password manager fires a *trusted* focus/input/change sequence
   * on an unmarked type="password" control during page load and fills it with a
   * generated value, without the field ever becoming activeElement. Treating that
   * as typing stored a password nobody chose. `isTrusted` cannot tell the two
   * apart and neither can focus, so this keys off an input gesture instead:
   * autofill produces no keydown, paste or pointerdown. The markup also carries
   * autocomplete="new-password" to stop it at the source (views/index.ejs); this
   * is the second line of defence, because autocomplete is a hint browsers are
   * free to ignore.
   *
   * A pointerdown counts as intent, so choosing a saved credential from the
   * browser's dropdown after clicking the field still saves, which is what the
   * operator asked for.
   */
  var passwordIntent = false;

  /** Set false the first time sessionStorage throws, so we warn once, not per keystroke. */
  var storageWorks = true;

  function byId(id) {
    return document.getElementById(id);
  }

  /**
   * The logged-in email, rendered into the page by views/index.ejs. Used to stamp
   * the draft so it cannot be handed to a different operator signing in on this
   * same tab. Empty string if unavailable, which disables the check rather than
   * discarding every draft.
   */
  function currentUser() {
    var body = document.body;
    if (!body) return '';
    return (body.getAttribute('data-user-email') || '').trim();
  }

  function warnStorage(action, err) {
    if (!storageWorks) return;
    storageWorks = false;
    console.warn('Form state ' + action + ' unavailable (' + err.message + '). ' +
      'The form will still work, but will not survive a refresh in this tab.');
  }

  /**
   * Drops values the original implementation left in localStorage. They are
   * unscoped by user, so leaving them would keep one operator's host/port/user
   * readable to the next person to log in on this browser.
   */
  function purgeLegacyLocalStorage() {
    try {
      LEGACY_LOCAL_KEYS.forEach(function (key) {
        localStorage.removeItem(key);
      });
    } catch (err) {
      // Private mode or blocked storage. Nothing to clean up.
    }
  }

  /**
   * Snapshots every persisted control.
   *
   * Empty strings are included deliberately. A cleared field is a real state the
   * operator chose, and skipping it here is what previously made a cleared field
   * come back populated after a reload.
   */
  function collect() {
    var fields = {};

    TEXT_FIELDS.forEach(function (field) {
      var el = byId(field.id);
      if (el) fields[field.key] = el.value;
    });

    RADIO_GROUPS.forEach(function (group) {
      fields[group.key] = '';
      Object.keys(group.options).forEach(function (value) {
        var el = byId(group.options[value]);
        if (el && el.checked) fields[group.key] = value;
      });
    });

    return fields;
  }

  function clearDraft() {
    try {
      sessionStorage.removeItem(STORAGE_KEY);
    } catch (err) {
      warnStorage('cleanup', err);
    }
  }

  function writeDraft(fields) {
    var raw;

    try {
      raw = JSON.stringify({
        version: SCHEMA_VERSION,
        user: currentUser(),
        savedAt: new Date().toISOString(),
        fields: fields
      });
    } catch (err) {
      console.warn('Could not serialise form state:', err.message);
      return;
    }

    try {
      sessionStorage.setItem(STORAGE_KEY, raw);
    } catch (err) {
      // Most likely QuotaExceededError on a very large message body, or storage
      // blocked entirely. Either way this must not interrupt typing.
      warnStorage('save', err);
    }
  }

  /**
   * Returns the stored field map, or null when there is nothing usable.
   *
   * Every failure path removes the payload rather than leaving it to be retried on
   * the next load: anything we cannot read is anything we cannot restore.
   */
  function readDraft() {
    var raw;

    try {
      raw = sessionStorage.getItem(STORAGE_KEY);
    } catch (err) {
      warnStorage('load', err);
      return null;
    }

    if (!raw) return null;

    var parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      console.warn('Stored form state was not valid JSON; discarding it.');
      clearDraft();
      return null;
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      clearDraft();
      return null;
    }

    if (parsed.version !== SCHEMA_VERSION) {
      // Written by an older build. Restoring it could put values in the wrong
      // controls, so it is dropped.
      clearDraft();
      return null;
    }

    if (!parsed.fields || typeof parsed.fields !== 'object' || Array.isArray(parsed.fields)) {
      clearDraft();
      return null;
    }

    // Belongs to whoever was signed in before. Not ours to restore.
    var user = currentUser();
    if (user && parsed.user !== user) {
      clearDraft();
      return null;
    }

    return parsed.fields;
  }

  function applyDraft(fields) {
    TEXT_FIELDS.forEach(function (field) {
      var el = byId(field.id);
      if (!el) return;

      var value = fields[field.key];
      if (typeof value !== 'string') return;

      // Assigned even when empty, so a field the operator cleared stays cleared.
      el.value = value;
    });

    var changed = [];

    RADIO_GROUPS.forEach(function (group) {
      var value = fields[group.key];

      // '' is a real stored state: neither radio starts checked, and
      // recipents-upload.js picks the default on load. Nothing to apply.
      if (typeof value !== 'string' || value === '') return;

      var id = group.options[value];
      if (!id) return; // unknown value from an older or hand-edited payload

      var el = byId(id);
      if (el && !el.checked) {
        el.checked = true;
        changed.push(el);
      }
    });

    // Setting `checked` in script fires no event, so other modules that key off
    // these radios (updateModeUI in recipents-upload.js, the Auto IMAP Test gate
    // in imap-checker.js) would keep rendering the pre-restore mode. Dispatching
    // lets them resynchronise through their normal listeners.
    changed.forEach(function (el) {
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });

    if (typeof window.updateModeUI === 'function') window.updateModeUI();
  }

  function scheduleSave() {
    if (restoring) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      saveTimer = null;
      writeDraft(collect());
    }, SAVE_DEBOUNCE_MS);
  }

  /** Writes any pending debounced change immediately. */
  function flushSave() {
    if (!saveTimer) return;
    clearTimeout(saveTimer);
    saveTimer = null;
    writeDraft(collect());
  }

  /* ----------------------------------------------------------------------
     SMTP password. Server-side only; never placed in browser storage.
     ---------------------------------------------------------------------- */

  /**
   * Tells the operator a saved password will be used, since the field itself
   * stays empty by design.
   */
  function markStoredPassword(hasSmtpPass) {
    var hint = byId('smtp-pass-hint');
    var pass = byId('smtp-pass');

    if (!hasSmtpPass) {
      if (hint) hint.textContent = '';
      if (pass) pass.placeholder = 'Enter SMTP Password';
      return;
    }

    if (pass) pass.placeholder = 'Saved password will be used';
    if (hint) {
      hint.textContent = 'A saved password is stored securely on the server and will be used when you send. Type here to replace it.';
    }
  }

  /**
   * Empties the password field when the browser, rather than the operator, put a
   * value in it. Returns true if something was discarded.
   *
   * Called immediately before the form is serialised for /send-email. The
   * autocomplete hints in views/index.ejs are only hints, so a browser is free to
   * autofill this field anyway; when it does, that value would be submitted as
   * `smtp-pass` and /send-email prefers a submitted password over the stored one.
   * The campaign would then authenticate with a generated string nobody chose and
   * fail, while a perfectly good credential sat in the database unused.
   *
   * An empty field is not a loss of information: it is precisely how this form
   * says "use the saved password" after a refresh, which is the state /send-email
   * already resolves through resolveSmtpPass. So discarding an un-gestured value
   * restores the intended behaviour rather than removing a capability.
   *
   * Deliberately keyed on the same gesture flag as saving, so the two can never
   * disagree: a value good enough to store is a value good enough to send.
   * Idempotent, so being called from both the submit listener here and the submit
   * handler in recipents-upload.js is harmless.
   */
  function discardUngesturedPassword() {
    if (passwordIntent) return false;

    var pass = byId('smtp-pass');
    if (!pass || pass.value === '') return false;

    pass.value = '';
    console.warn('Ignored an SMTP password this browser filled in by itself. ' +
      'Any password saved on the server will be used instead — type one to override it.');
    return true;
  }

  function savePassword(useKeepalive) {
    var pass = byId('smtp-pass');
    if (!pass) return;

    var value = pass.value;
    var options = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ smtpPass: value })
    };

    // keepalive lets the request outlive the page when the tab is closing.
    if (useKeepalive) options.keepalive = true;

    fetch(CREDENTIAL_ENDPOINT, options)
      .then(function (res) {
        if (!res.ok) {
          console.warn('SMTP password save failed with HTTP ' + res.status);
          return;
        }

        // Clearing the field clears the stored credential, so the "a saved
        // password will be used" hint has to go with it. A non-empty save leaves
        // the hint alone: the field already shows what will be sent.
        if (value === '') markStoredPassword(false);
      })
      .catch(function (err) {
        console.warn('SMTP password save failed:', err.message);
      });
  }

  function schedulePasswordSave() {
    if (restoring) return;
    if (passwordTimer) clearTimeout(passwordTimer);
    passwordTimer = setTimeout(function () {
      passwordTimer = null;
      savePassword(false);
    }, SAVE_DEBOUNCE_MS);
  }

  function flushPassword(useKeepalive) {
    if (!passwordTimer) return;
    clearTimeout(passwordTimer);
    passwordTimer = null;
    savePassword(useKeepalive);
  }

  /** Asks the server only whether a password is stored, never what it is. */
  async function loadCredentialState() {
    try {
      var res = await fetch(CREDENTIAL_ENDPOINT, { headers: { Accept: 'application/json' } });
      if (!res.ok) {
        // 401 means the guard is redirecting to login; nothing to report.
        if (res.status !== 401) console.warn('Could not check for a saved SMTP password: HTTP ' + res.status);
        return;
      }

      var payload = await res.json();
      if (!payload || payload.success !== true) return;

      markStoredPassword(Boolean(payload.hasSmtpPass));
    } catch (err) {
      // Network failure or a non-JSON body. The field keeps its default hint.
      console.warn('Could not check for a saved SMTP password:', err.message);
    }
  }

  /* ---------------------------------------------------------------------- */

  function restore() {
    var fields = readDraft();
    if (!fields) return;

    restoring = true;
    try {
      applyDraft(fields);
    } catch (err) {
      console.warn('Stored form state could not be applied:', err.message);
    } finally {
      restoring = false;
    }
  }

  /**
   * Marks restore as settled, so anything waiting on the form (and the browser
   * tests) has one reliable signal that it reflects the stored draft.
   */
  function markRestoreComplete() {
    document.documentElement.setAttribute('data-form-restored', 'true');
  }

  function attachListeners() {
    var form = byId('email-form');
    if (!form) return;

    // Covers typing, pastes and radios in one place.
    form.addEventListener('input', scheduleSave);
    form.addEventListener('change', scheduleSave);

    var pass = byId('smtp-pass');
    if (pass) {
      ['keydown', 'paste', 'pointerdown'].forEach(function (type) {
        pass.addEventListener(type, function () {
          passwordIntent = true;
        });
      });

      pass.addEventListener('input', function () {
        // No gesture yet means the browser filled this in by itself. Saving it
        // would overwrite the real stored credential with a generated one.
        if (!passwordIntent) return;

        schedulePasswordSave();
      });
    }

    // Backstop for a native form submission, which is what happens if
    // recipents-upload.js fails to load and its preventDefault never runs. On the
    // normal path its submit handler calls discardUngesturedPassword() explicitly
    // before building the FormData, because a listener registered here cannot be
    // guaranteed to run before one registered while that script was evaluating.
    form.addEventListener('submit', function () {
      discardUngesturedPassword();
    });

    // pagehide covers tab close, navigation away and the back/forward cache;
    // visibilitychange covers tab switches and mobile backgrounding. The draft
    // write is synchronous, so unlike the previous network save it cannot be cut
    // short by the page going away.
    window.addEventListener('pagehide', function () {
      flushSave();
      flushPassword(true);
    });
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') {
        flushSave();
        flushPassword(true);
      }
    });
  }

  window.FormPersistence = {
    /** Commits anything still inside the debounce window. Used before submit. */
    flush: function () {
      flushSave();
      flushPassword(false);
    },
    save: function () {
      writeDraft(collect());
    },
    /** Drops this tab's draft. Used on logout. */
    clear: clearDraft,
    /**
     * Discards a password the browser autofilled without the operator touching
     * the field. Must be called before the form is serialised for /send-email.
     */
    discardUngesturedPassword: discardUngesturedPassword,
    /** Test seam: whether the operator has interacted with the password field. */
    hasPasswordIntent: function () {
      return passwordIntent;
    }
  };

  window.addEventListener('DOMContentLoaded', function () {
    purgeLegacyLocalStorage();

    // Synchronous, so the form reflects the draft before any other module's
    // DOMContentLoaded handler reads the radios. A back/forward navigation served
    // from the back/forward cache does not re-run this, which is correct: that
    // page's DOM was never torn down and already holds the right values.
    restore();
    attachListeners();
    markRestoreComplete();

    // Independent of the draft, and allowed to resolve late: it only adjusts the
    // password field's placeholder and hint.
    loadCredentialState();
  });
})();
