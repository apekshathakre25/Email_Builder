/**
 * Persists the campaign form on /interface so a refresh does not clear it.
 *
 * The draft lives server-side in the EmailConfig collection, keyed on the login
 * email, rather than in localStorage. Two reasons: localStorage is shared by
 * every account that uses the same browser profile, so one operator's SMTP
 * configuration would be handed to the next; and the SMTP password has to be
 * encrypted at rest, which only the server can do (utils/credentialCipher).
 *
 * The password is write-only from the browser's point of view. It is sent when
 * the operator types one and is never sent back, so after a refresh the field is
 * empty and /send-email substitutes the stored credential.
 */
(function () {
  'use strict';

  var SAVE_DEBOUNCE_MS = 600;
  var ENDPOINT = '/email-config';

  /** Form control id -> EmailConfig key. */
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
    { id: 'limit', key: 'limit' }
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

  /** Browser-storage keys from the previous localStorage-based implementation. */
  var LEGACY_LOCAL_KEYS = ['smtpHost', 'smtpPort', 'smtpUser', 'smtpPass'];

  var saveTimer = null;
  var restoring = false;
  var passwordTouched = false;

  function byId(id) {
    return document.getElementById(id);
  }

  /**
   * Drops values the old implementation left behind. They are unscoped by user,
   * so leaving them would keep one operator's host/port/user readable to the
   * next person to log in on this browser.
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

  function collect() {
    var payload = {};

    TEXT_FIELDS.forEach(function (field) {
      var el = byId(field.id);
      if (el) payload[field.key] = el.value;
    });

    RADIO_GROUPS.forEach(function (group) {
      payload[group.key] = '';
      Object.keys(group.options).forEach(function (value) {
        var el = byId(group.options[value]);
        if (el && el.checked) payload[group.key] = value;
      });
    });

    // Only included once the operator actually types, so an autosave triggered
    // by any other field cannot blank out the stored credential.
    if (passwordTouched) {
      var pass = byId('smtp-pass');
      if (pass) payload.smtpPass = pass.value;
    }

    return payload;
  }

  function save(useKeepalive) {
    var body;
    try {
      body = JSON.stringify(collect());
    } catch (err) {
      console.warn('Could not serialise form state:', err);
      return;
    }

    var options = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body
    };

    // keepalive lets the request outlive the page when the tab is closing.
    if (useKeepalive) options.keepalive = true;

    fetch(ENDPOINT, options)
      .then(function (res) {
        if (!res.ok) console.warn('Form state save failed with HTTP ' + res.status);
        else passwordTouched = false;
      })
      .catch(function (err) {
        console.warn('Form state save failed:', err.message);
      });
  }

  function scheduleSave() {
    if (restoring) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      saveTimer = null;
      save(false);
    }, SAVE_DEBOUNCE_MS);
  }

  /** Writes any pending debounced change immediately. */
  function flush(useKeepalive) {
    if (!saveTimer) return;
    clearTimeout(saveTimer);
    saveTimer = null;
    save(useKeepalive);
  }

  function applyConfig(config, hasSmtpPass) {
    TEXT_FIELDS.forEach(function (field) {
      var el = byId(field.id);
      if (!el) return;
      var value = config[field.key];
      if (typeof value === 'string' && value !== '') el.value = value;
    });

    var changed = [];

    RADIO_GROUPS.forEach(function (group) {
      var value = config[group.key];
      if (typeof value !== 'string' || value === '') return;

      var id = group.options[value];
      if (!id) return; // unknown value from an older or hand-edited record

      var el = byId(id);
      if (el && !el.checked) {
        el.checked = true;
        changed.push(el);
      }
    });

    // Setting `checked` in script fires no event, so other modules that key off
    // these radios (updateModeUI here, the Auto IMAP Test gate in
    // imap-checker.js) would keep rendering the pre-restore mode. Dispatching
    // lets them resynchronise through their normal listeners.
    changed.forEach(function (el) {
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });

    if (typeof window.updateModeUI === 'function') window.updateModeUI();

    markStoredPassword(hasSmtpPass);
  }

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

  async function restore() {
    var payload;

    try {
      var res = await fetch(ENDPOINT, { headers: { Accept: 'application/json' } });
      if (!res.ok) {
        // 401 means the guard is redirecting to login; nothing to restore.
        if (res.status !== 401) console.warn('Could not load saved form state: HTTP ' + res.status);
        return;
      }
      payload = await res.json();
    } catch (err) {
      // Network failure or a non-JSON body. Leave the form at its defaults.
      console.warn('Could not load saved form state:', err.message);
      return;
    }

    // Tolerate anything that is not the expected shape rather than throwing and
    // taking the rest of the page's initialisation down with it.
    if (!payload || payload.success !== true) return;
    if (!payload.config || typeof payload.config !== 'object') {
      markStoredPassword(Boolean(payload.hasSmtpPass));
      return;
    }

    restoring = true;
    try {
      applyConfig(payload.config, Boolean(payload.hasSmtpPass));
    } catch (err) {
      console.warn('Saved form state could not be applied:', err.message);
    } finally {
      restoring = false;
    }
  }

  /**
   * Marks restore as settled. Because restore is asynchronous, this is the only
   * reliable point at which the form can be said to reflect the saved draft.
   */
  function markRestoreComplete() {
    document.documentElement.setAttribute('data-form-restored', 'true');
  }

  function attachListeners() {
    var form = byId('email-form');
    if (!form) return;

    // Covers typing, pastes, radios and the password field in one place.
    form.addEventListener('input', scheduleSave);
    form.addEventListener('change', scheduleSave);

    var pass = byId('smtp-pass');
    if (pass) {
      pass.addEventListener('input', function () {
        passwordTouched = true;
      });
    }

    // pagehide covers tab close, navigation away and the back/forward cache;
    // visibilitychange covers tab switches and mobile backgrounding.
    window.addEventListener('pagehide', function () {
      flush(true);
    });
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') flush(true);
    });
  }

  window.FormPersistence = {
    flush: function () {
      flush(false);
    },
    save: function () {
      save(false);
    }
  };

  window.addEventListener('DOMContentLoaded', function () {
    purgeLegacyLocalStorage();

    // Listeners are attached only after the restore settles, so the async
    // response cannot be raced by a save of the still-empty form.
    restore().finally(function () {
      attachListeners();
      markRestoreComplete();
    });
  });
})();
