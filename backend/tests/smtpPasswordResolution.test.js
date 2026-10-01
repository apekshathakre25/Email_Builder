/**
 * The SMTP password contract between the browser and /send-email.
 *
 * Two behaviours depend on this and are tested here together because neither is
 * safe without the other:
 *
 *   1. The password field is never repopulated after a reload, so an empty
 *      `smtp-pass` in a submission means "use the credential saved for this
 *      operator". resolveSmtpPass is what honours that.
 *
 *   2. Because of (1), public/js/form-persistence.js clears the field when the
 *      browser autofilled it without the operator touching it
 *      (discardUngesturedPassword). That is only correct if an emptied field
 *      reliably falls back to the stored credential rather than sending nothing —
 *      which is exactly what these tests pin down.
 *
 * The motivating defect: Chromium's password manager fires a trusted
 * focus/input/change on an unmarked type="password" control during page load and
 * fills it with a generated value. That value was being stored as the operator's
 * credential and submitted to /send-email, which prefers a submitted password, so
 * sending authenticated with a string nobody had chosen while a working credential
 * sat unused in the database.
 *
 * Also asserts that the endpoint never hands the password back to the browser, and
 * that it no longer carries the campaign form, which now lives in sessionStorage.
 */

// Required first: it moves Redis onto an isolated database before
// routes/sendemails (which builds a client at require time) can be loaded.
const {
  startTestDb,
  stopTestDb,
  clearCollections,
  clearTestRedisKeys,
  getSharedRedisClient
} = require('./helpers/testDb');

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const EmailConfig = require('../models/EmailConfig');
const { encrypt } = require('../utils/credentialCipher');

const sendEmailsRouter = require('../routes/sendemails');
const { resolveSmtpPass } = sendEmailsRouter;

const USER = 'tester@example.com';

let server;
let baseUrl;

function buildTestApp() {
  const app = express();
  app.use(express.json());

  // The router is mounted behind authenticateToken in app.js and reads
  // req.user.email; this stands in for that without involving JWTs.
  app.use((req, res, next) => {
    req.user = { email: USER, name: 'Tester' };
    next();
  });

  app.use('/', sendEmailsRouter);
  return app;
}

/** Writes a stored credential the way POST /email-config would. */
async function storeCredential(plaintext, userId = USER) {
  await EmailConfig.findOneAndUpdate(
    { userId },
    { userId, smtpPass: encrypt(plaintext), updatedAt: new Date() },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
}

async function readStoredCipher(userId = USER) {
  const doc = await EmailConfig.findOne({ userId }).select('+smtpPass');
  return doc ? doc.smtpPass : null;
}

test.before(async () => {
  await startTestDb();
  getSharedRedisClient();
  await clearTestRedisKeys();

  const app = buildTestApp();
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await clearTestRedisKeys();
  await stopTestDb();
});

test.beforeEach(async () => {
  await clearCollections();
});

test('resolveSmtpPass is exported so the send path can be tested', () => {
  assert.equal(typeof resolveSmtpPass, 'function');
  assert.equal(typeof sendEmailsRouter, 'function', 'the router itself must stay mountable');
});

/* ------------------------------------------------------------------ *
 * The fallback that makes discarding an autofilled password safe.
 * ------------------------------------------------------------------ */

test('an empty submitted password falls back to the stored credential', async () => {
  await storeCredential('the-real-smtp-password');

  // '' is what the browser sends after a reload, and now also what it sends when
  // it discarded a password the browser autofilled by itself.
  assert.equal(await resolveSmtpPass(USER, ''), 'the-real-smtp-password');
});

test('undefined and null submitted passwords also fall back to the stored credential', async () => {
  await storeCredential('the-real-smtp-password');

  assert.equal(await resolveSmtpPass(USER, undefined), 'the-real-smtp-password');
  assert.equal(await resolveSmtpPass(USER, null), 'the-real-smtp-password');
});

test('a submitted password wins, so a deliberate change is never overridden', async () => {
  await storeCredential('the-old-password');

  assert.equal(
    await resolveSmtpPass(USER, 'freshly-typed-password'),
    'freshly-typed-password',
    'typing a new password must take effect immediately, not the saved one'
  );
});

test('with nothing stored, the submitted value is returned unchanged', async () => {
  assert.equal(await resolveSmtpPass(USER, 'only-submitted'), 'only-submitted');
  assert.equal(await resolveSmtpPass(USER, ''), '', 'no credential and no input stays empty');
});

test('one operator never resolves to another operator\'s credential', async () => {
  await storeCredential('other-operators-password', 'someone.else@example.com');

  assert.equal(await resolveSmtpPass(USER, ''), '', 'must not read across userId');
});

test('an undecryptable stored credential does not fall back to ciphertext', async () => {
  await EmailConfig.findOneAndUpdate(
    { userId: USER },
    { userId: USER, smtpPass: 'enc:v1:not-real-ciphertext', updatedAt: new Date() },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  // Returning the raw stored value here would hand ciphertext to the SMTP server
  // as a password; the submitted value is the only safe answer.
  assert.equal(await resolveSmtpPass(USER, ''), '');
});

/* ------------------------------------------------------------------ *
 * Storage semantics: absent key vs empty string vs a real password.
 * ------------------------------------------------------------------ */

test('POST /email-config stores the password encrypted, never in plaintext', async () => {
  const res = await fetch(`${baseUrl}/email-config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ smtpPass: 'plain-text-secret' })
  });

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { success: true, updated: true });

  const stored = await readStoredCipher();
  assert.notEqual(stored, 'plain-text-secret', 'must not be stored in plaintext');
  assert.match(stored, /^enc:v1:/, 'must be AES-256-GCM ciphertext from credentialCipher');
  assert.equal(await resolveSmtpPass(USER, ''), 'plain-text-secret', 'and must decrypt back');
});

test('POST /email-config with an empty string clears the stored credential', async () => {
  await storeCredential('to-be-cleared');

  const res = await fetch(`${baseUrl}/email-config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ smtpPass: '' })
  });

  assert.equal(res.status, 200);
  assert.equal(await readStoredCipher(), '', 'clearing the field clears the credential');
  assert.equal(await resolveSmtpPass(USER, ''), '');
});

test('POST /email-config without the key leaves the stored credential untouched', async () => {
  await storeCredential('must-survive');
  const before = await readStoredCipher();

  // This is the shape any non-password write would have had. Nothing else is
  // persisted server-side any more, but the guarantee still matters: an absent key
  // must never be read as "clear it".
  const res = await fetch(`${baseUrl}/email-config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ smtpHost: 'smtp.example.com', subject: 'ignored' })
  });

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { success: true, updated: false });
  assert.equal(await readStoredCipher(), before);
  assert.equal(await resolveSmtpPass(USER, ''), 'must-survive');
});

/* ------------------------------------------------------------------ *
 * The endpoint must not leak the secret, or carry the form any more.
 * ------------------------------------------------------------------ */

test('GET /email-config reports only whether a password is stored', async () => {
  const empty = await (await fetch(`${baseUrl}/email-config`)).json();
  assert.deepEqual(empty, { success: true, hasSmtpPass: false });

  await storeCredential('do-not-leak-me');

  const res = await fetch(`${baseUrl}/email-config`);
  const body = await res.text();

  assert.deepEqual(JSON.parse(body), { success: true, hasSmtpPass: true });
  assert.ok(!body.includes('do-not-leak-me'), 'plaintext must never reach the browser');
  assert.ok(!body.includes('enc:v1:'), 'ciphertext must never reach the browser either');
  assert.ok(!/smtpPass"\s*:/.test(body), 'no smtpPass field at all');
});

test('GET /email-config no longer returns campaign form fields', async () => {
  await storeCredential('anything');

  const body = await (await fetch(`${baseUrl}/email-config`)).json();

  // The form draft lives in each tab's sessionStorage now. If these ever come
  // back, two tabs are sharing server state again and the multi-tab bug returns.
  for (const retired of ['config', 'smtpHost', 'subject', 'message', 'limit', 'fileIds']) {
    assert.equal(body[retired], undefined, `${retired} must not be served any more`);
  }
});

test('the stored document holds only the credential, not the form', async () => {
  await storeCredential('anything');

  const doc = await EmailConfig.findOne({ userId: USER }).select('+smtpPass');
  const keys = Object.keys(doc.toObject()).sort();

  assert.deepEqual(keys, ['__v', '_id', 'smtpPass', 'updatedAt', 'userId']);
});

test('DELETE /email-config removes the stored credential', async () => {
  await storeCredential('bye');

  const res = await fetch(`${baseUrl}/email-config`, { method: 'DELETE' });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { success: true });

  assert.equal(await EmailConfig.countDocuments({ userId: USER }), 0);
  assert.equal(await resolveSmtpPass(USER, ''), '');
});
