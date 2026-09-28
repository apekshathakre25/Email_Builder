/**
 * public/js/form-persistence.js — the SMTP password gesture guard.
 *
 * The defect these tests exist for: Chromium's password manager treats the
 * `smtp-user` + `smtp-pass` pair as a login form, and during page load fires a
 * *trusted* focus/input/change sequence on the password field, filling it with a
 * generated value. The field never becomes activeElement and `isTrusted` is true,
 * so neither focus nor isTrusted can distinguish it from the operator typing.
 *
 * Two things went wrong as a result. The generated value was saved as the
 * operator's stored credential, and it was submitted to /send-email — which
 * prefers a submitted password over the stored one — so campaigns authenticated
 * with a string nobody had chosen while a working credential sat unused.
 *
 * The guard keys off an input *gesture* instead: autofill produces no keydown,
 * paste or pointerdown. Anything filled without one of those is neither saved nor
 * submitted. Selecting a saved credential from the browser's own dropdown still
 * counts, because reaching it requires clicking or keying into the field.
 *
 * Run in jsdom against the real module rather than a reimplementation, so the
 * event wiring is covered and not just the decision.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const MODULE_PATH = path.join(__dirname, '..', 'public', 'js', 'form-persistence.js');
const MODULE_SOURCE = fs.readFileSync(MODULE_PATH, 'utf8');

const STORAGE_KEY = 'opterite:campaign-form';
const USER = 'operator@example.com';
const DEBOUNCE_MS = 250;

/** Long enough for the module's 250ms debounce to fire. */
const settle = () => new Promise((resolve) => setTimeout(resolve, DEBOUNCE_MS + 150));

/**
 * The parts of views/index.ejs the module touches. Kept minimal on purpose: if a
 * control is renamed there, these tests should fail loudly rather than quietly
 * exercise nothing.
 */
const PAGE = `<!DOCTYPE html>
<html>
  <body data-user-email="${USER}">
    <form id="email-form" autocomplete="off">
      <input type="text" id="smtp-host" name="smtp-host" />
      <input type="text" id="smtp-port" name="smtp-port" />
      <input type="text" id="smtp-user" name="smtp-user" autocomplete="off" />
      <input type="password" id="smtp-pass" name="smtp-pass" autocomplete="new-password" />
      <span id="smtp-pass-hint"></span>
      <textarea id="custom-headers"></textarea>
      <input type="text" id="smtp-from-email" />
      <input type="text" id="subject" />
      <input type="text" id="smtp-from-name" />
      <textarea id="test-recp"></textarea>
      <input type="radio" name="test-bulk" id="bulk" />
      <input type="radio" name="test-bulk" id="test" />
      <input type="radio" name="message-type" id="plain" />
      <input type="radio" name="message-type" id="html" />
      <textarea id="message"></textarea>
      <input type="text" id="file-ids" />
      <input type="text" id="custom-message-id" />
      <input type="number" id="limit" />
      <input type="number" id="interval-seconds" />
    </form>
  </body>
</html>`;

/**
 * Boots the module in a fresh jsdom window.
 *
 * The module initialises on DOMContentLoaded, which jsdom has already fired by the
 * time the source is evaluated, so a bubbling one is dispatched afterwards to
 * reach the window listener.
 */
async function boot({ hasSmtpPass = false } = {}) {
  const dom = new JSDOM(PAGE, {
    url: 'https://localhost/interface',
    runScripts: 'outside-only'
  });
  const win = dom.window;

  const calls = [];
  win.fetch = function (url, opts) {
    const options = opts || {};
    calls.push({
      url: String(url),
      method: options.method || 'GET',
      body: options.body ? JSON.parse(options.body) : null
    });

    if ((options.method || 'GET') === 'GET') {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ success: true, hasSmtpPass })
      });
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ success: true }) });
  };

  win.eval(MODULE_SOURCE);
  win.document.dispatchEvent(new win.Event('DOMContentLoaded', { bubbles: true }));

  // Lets the GET in loadCredentialState resolve before assertions run.
  await new Promise((resolve) => setTimeout(resolve, 20));

  const byId = (id) => win.document.getElementById(id);
  const pass = byId('smtp-pass');

  return {
    win,
    dom,
    calls,
    pass,
    byId,
    api: () => win.FormPersistence,
    posts: () => calls.filter((c) => c.method === 'POST'),

    /** What the browser's password manager does: a value with no input gesture. */
    autofillPassword(value) {
      pass.dispatchEvent(new win.Event('focus'));
      pass.value = value;
      pass.dispatchEvent(new win.Event('input', { bubbles: true }));
      pass.dispatchEvent(new win.Event('change', { bubbles: true }));
    },

    /** What the operator does: a keystroke, then the resulting value. */
    typePassword(value) {
      pass.dispatchEvent(new win.Event('pointerdown', { bubbles: true }));
      for (const ch of value) {
        pass.dispatchEvent(new win.KeyboardEvent('keydown', { key: ch, bubbles: true }));
        pass.value += ch;
        pass.dispatchEvent(new win.Event('input', { bubbles: true }));
      }
    },

    submit() {
      byId('email-form').dispatchEvent(
        new win.Event('submit', { bubbles: true, cancelable: true })
      );
    },

    draft() {
      const raw = win.sessionStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    },

    close() {
      dom.window.close();
    }
  };
}

/* ------------------------------------------------------------------ *
 * The fix: an autofilled password is neither saved nor submitted.
 * ------------------------------------------------------------------ */

test('a password autofilled without a gesture is not saved to the server', async () => {
  const h = await boot();
  try {
    h.autofillPassword('ya3K9svClqbqGVcl');
    await settle();

    assert.deepEqual(h.posts(), [], 'no POST may be made for a password the browser invented');
    assert.equal(h.api().hasPasswordIntent(), false);
  } finally {
    h.close();
  }
});

test('a password autofilled without a gesture is discarded before submit', async () => {
  const h = await boot({ hasSmtpPass: true });
  try {
    h.autofillPassword('ya3K9svClqbqGVcl');
    await settle();
    assert.equal(h.pass.value, 'ya3K9svClqbqGVcl', 'the browser really did fill the field');

    h.submit();

    // Empty is how the form asks /send-email to use the stored credential, which
    // is exactly the intended outcome here.
    assert.equal(h.pass.value, '', 'the autofilled value must not reach /send-email');
  } finally {
    h.close();
  }
});

test('discardUngesturedPassword reports what it did and is idempotent', async () => {
  const h = await boot();
  try {
    assert.equal(h.api().discardUngesturedPassword(), false, 'nothing to discard on a clean form');

    h.autofillPassword('generated-value');
    assert.equal(h.api().discardUngesturedPassword(), true, 'discards the autofilled value');
    assert.equal(h.pass.value, '');

    assert.equal(h.api().discardUngesturedPassword(), false, 'second call is a no-op');
    assert.equal(h.pass.value, '');
  } finally {
    h.close();
  }
});

/* ------------------------------------------------------------------ *
 * Legitimate entry must be entirely unaffected.
 * ------------------------------------------------------------------ */

test('a typed password is saved to the server', async () => {
  const h = await boot();
  try {
    h.typePassword('Operator-Chosen-1');
    await settle();

    const posts = h.posts();
    assert.equal(posts.length, 1, 'exactly one save for the typed password');
    assert.equal(posts[0].url, '/email-config');
    assert.deepEqual(posts[0].body, { smtpPass: 'Operator-Chosen-1' });
    assert.equal(h.api().hasPasswordIntent(), true);
  } finally {
    h.close();
  }
});

test('a typed password survives submit', async () => {
  const h = await boot();
  try {
    h.typePassword('Operator-Chosen-1');
    await settle();

    h.submit();

    assert.equal(h.pass.value, 'Operator-Chosen-1', 'a deliberate password must still be sent');
    assert.equal(h.api().discardUngesturedPassword(), false);
  } finally {
    h.close();
  }
});

test('a credential picked from the browser dropdown after clicking the field is kept', async () => {
  const h = await boot();
  try {
    // Reaching the dropdown requires interacting with the field first, so the
    // gesture is real even though the value arrives via autofill.
    h.pass.dispatchEvent(new h.win.Event('pointerdown', { bubbles: true }));
    h.autofillPassword('saved-credential-from-browser');
    await settle();

    assert.equal(h.posts().length, 1, 'an intentional autofill is a real password change');
    assert.deepEqual(h.posts()[0].body, { smtpPass: 'saved-credential-from-browser' });

    h.submit();
    assert.equal(h.pass.value, 'saved-credential-from-browser', 'and must be submitted');
  } finally {
    h.close();
  }
});

test('a keyboard-selected credential is kept, so keyboard-only users are not penalised', async () => {
  const h = await boot();
  try {
    // Tab moves focus, then arrow keys and Enter choose an entry: all keydowns on
    // the field itself.
    h.pass.dispatchEvent(new h.win.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    h.autofillPassword('keyboard-selected-credential');
    await settle();

    assert.equal(h.posts().length, 1);
    h.submit();
    assert.equal(h.pass.value, 'keyboard-selected-credential');
  } finally {
    h.close();
  }
});

test('a pasted password counts as a gesture', async () => {
  const h = await boot();
  try {
    h.pass.dispatchEvent(new h.win.Event('paste', { bubbles: true }));
    h.pass.value = 'pasted-password';
    h.pass.dispatchEvent(new h.win.Event('input', { bubbles: true }));
    await settle();

    assert.equal(h.posts().length, 1);
    assert.deepEqual(h.posts()[0].body, { smtpPass: 'pasted-password' });

    h.submit();
    assert.equal(h.pass.value, 'pasted-password');
  } finally {
    h.close();
  }
});

test('clearing the field after a gesture still clears the stored credential', async () => {
  const h = await boot({ hasSmtpPass: true });
  try {
    h.typePassword('x');
    await settle();

    h.pass.dispatchEvent(new h.win.KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }));
    h.pass.value = '';
    h.pass.dispatchEvent(new h.win.Event('input', { bubbles: true }));
    await settle();

    const last = h.posts().at(-1);
    assert.deepEqual(last.body, { smtpPass: '' }, 'an emptied field must clear the credential');
  } finally {
    h.close();
  }
});

/* ------------------------------------------------------------------ *
 * The password must never reach browser storage, gesture or not.
 * ------------------------------------------------------------------ */

test('the sessionStorage draft never contains the password', async () => {
  const h = await boot();
  try {
    h.byId('smtp-host').value = 'smtp.example.com';
    h.byId('smtp-host').dispatchEvent(new h.win.Event('input', { bubbles: true }));
    h.typePassword('Never-Store-Me-1');
    await settle();

    const draft = h.draft();
    assert.ok(draft, 'the non-sensitive draft is still written');
    assert.equal(draft.fields.smtpHost, 'smtp.example.com');
    assert.equal(draft.user, USER, 'and is stamped with the operator it belongs to');

    const raw = h.win.sessionStorage.getItem(STORAGE_KEY);
    assert.ok(!raw.includes('Never-Store-Me-1'), 'password value must not be in sessionStorage');
    assert.ok(!/smtpPass/i.test(raw), 'not even a key for it');
    assert.equal(draft.fields.smtpPass, undefined);
  } finally {
    h.close();
  }
});

test('an autofilled password is not written to sessionStorage either', async () => {
  const h = await boot();
  try {
    h.autofillPassword('ya3K9svClqbqGVcl');
    await settle();

    const raw = h.win.sessionStorage.getItem(STORAGE_KEY) || '';
    assert.ok(!raw.includes('ya3K9svClqbqGVcl'));
  } finally {
    h.close();
  }
});
