/**
 * Per-tab persistence for the campaign form.
 *
 * ── Why sessionStorage, and why per tab ──────────────────────────────────────
 *
 * The draft is temporary UI state, and an operator legitimately wants two tabs
 * holding two different drafts — one for each recipient file. sessionStorage is
 * scoped to the tab, so that works without either tab overwriting the other. It also
 * means closing the tab discards the draft, which is the right lifetime for it.
 *
 * This form was once persisted server-side, in the EmailConfig document, which meant
 * a database write per keystroke for data nothing ever read back: /send-email
 * receives every field in the request body, so the server only held them to repaint
 * the form after a refresh. The browser can do that itself.
 *
 * ── Why the payload is stamped with the operator's email ─────────────────────
 *
 * sessionStorage is scoped to the tab, not to the account, and survives a logout in
 * that tab. Without the stamp, the next person to sign in on that tab would inherit
 * the previous operator's SMTP host, user and sender identity. A mismatch discards
 * the draft rather than merging it.
 *
 * ── Why the SMTP password is absent ──────────────────────────────────────────
 *
 * It is the one field deliberately kept out of browser storage. The plaintext stays
 * on the server (encrypted, in EmailConfig) and /send-email substitutes it when the
 * submitted field is empty, so an empty password box means "use the saved one"
 * rather than "send with no password".
 */

const STORAGE_KEY = 'opterite:campaign-form';

/**
 * Hand-off slot for File IDs sent from the file manager's "Use in campaign" button.
 *
 * The previous app had the same intent — file-upload.ejs wrote
 * localStorage['pendingFileId'] — but nothing called the writer and nothing on the
 * dashboard read the key, so in practice an operator read the id off the screen, changed
 * page and retyped it.
 *
 * sessionStorage rather than localStorage, and per tab, for the same reason the draft is:
 * the id belongs to the campaign this tab is assembling, not to the browser profile.
 */
const PENDING_FILE_IDS_KEY = 'opterite:pending-file-ids';

/** Queues a File ID for the dashboard to pick up. Idempotent. */
export function queuePendingFileId(fileId) {
  const id = String(fileId ?? '').trim();
  if (!id) return;

  try {
    const existing = (window.sessionStorage.getItem(PENDING_FILE_IDS_KEY) ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);

    if (!existing.includes(id)) existing.push(id);
    window.sessionStorage.setItem(PENDING_FILE_IDS_KEY, existing.join(','));
  } catch {
    /* storage unavailable; the operator can still paste the id manually */
  }
}

/**
 * Reads and clears the queued File IDs.
 *
 * Clearing on read is deliberate: the ids have been consumed into the form, and leaving
 * them behind would re-add them on the next reload after the operator had removed them.
 */
export function consumePendingFileIds() {
  try {
    const raw = window.sessionStorage.getItem(PENDING_FILE_IDS_KEY);
    if (!raw) return [];

    window.sessionStorage.removeItem(PENDING_FILE_IDS_KEY);

    return raw
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Bumping this discards every existing draft.
 *
 * Correct behaviour rather than a limitation: a draft written by an older shape of
 * the form cannot be trusted to populate a newer one, and a half-restored campaign
 * form is more dangerous than an empty one.
 */
const SCHEMA_VERSION = 1;

/**
 * Persisted fields.
 *
 * Two are deliberately missing:
 *   smtpPass      — never in browser storage, see the module comment
 *   autoImapTest  — a per-send decision, not a preference. Restoring it would mean a
 *                   reload could silently re-arm IMAP checking the operator had
 *                   already turned off.
 */
export const PERSISTED_FIELDS = Object.freeze([
  'smtpHost',
  'smtpPort',
  'smtpUser',
  'customHeaders',
  'fromEmail',
  'subject',
  'fromName',
  'testRecipients',
  'message',
  'fileIds',
  'customMessageId',
  'inboxPatternId',
  'limit',
  'limitToSend',
  'intervalSeconds',
  'testBulk',
  'messageType',
  'contentTransferEncoding'
]);

/** The empty form. Also the shape restore() validates against. */
export const EMPTY_CAMPAIGN_FORM = Object.freeze({
  smtpHost: '',
  smtpPort: '',
  smtpUser: '',
  smtpPass: '',
  customHeaders: '',
  fromEmail: '',
  subject: '',
  fromName: '',
  testRecipients: '',
  message: '',
  fileIds: '',
  customMessageId: '',
  // Empty means Default: preserve the existing email generation behavior.
  inboxPatternId: '',
  limit: '',
  limitToSend: '',
  intervalSeconds: '',

  // Bulk is the effective default: it is what the old markup shipped checked.
  testBulk: 'Bulk',

  // Intentionally unset. Neither Plain nor HTML was checked in the original markup,
  // and silently defaulting to one would decide how a message is sent on the
  // operator's behalf.
  messageType: '',
  contentTransferEncoding: '7bit',

  autoImapTest: false
});

/**
 * Keys an earlier version of the app wrote to localStorage.
 *
 * Purged on every load. They were written only on submit and, being localStorage,
 * were shared by every account using the same browser profile — so one operator's
 * SMTP settings leaked into another's form. `smtpPass` is the reason this cleanup is
 * not merely tidiness: a stored credential must not be left behind.
 */
const LEGACY_LOCAL_STORAGE_KEYS = ['smtpHost', 'smtpPort', 'smtpUser', 'smtpPass'];

export function purgeLegacyLocalStorage() {
  try {
    for (const key of LEGACY_LOCAL_STORAGE_KEYS) window.localStorage.removeItem(key);
  } catch {
    // Storage can be unavailable (private mode, blocked cookies). Nothing here is
    // essential, so a failure is not worth surfacing.
  }
}

/**
 * Reads the draft for this operator.
 *
 * Returns null — meaning "start empty" — for anything suspicious, and deletes the
 * offending entry so it cannot be re-evaluated on every load: wrong schema version,
 * unparseable JSON, a non-object payload, or a draft belonging to somebody else.
 *
 * @param {string} userEmail The signed-in operator's email.
 * @returns {Partial<typeof EMPTY_CAMPAIGN_FORM>|null}
 */
export function readPersistedCampaignForm(userEmail) {
  let raw;
  try {
    raw = window.sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }

  if (!raw) return null;

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    clearPersistedCampaignForm();
    return null;
  }

  if (!parsed || typeof parsed !== 'object' || parsed.version !== SCHEMA_VERSION) {
    clearPersistedCampaignForm();
    return null;
  }

  if (!parsed.fields || typeof parsed.fields !== 'object') {
    clearPersistedCampaignForm();
    return null;
  }

  // Belongs to a different operator. Discard rather than ignore, so it is gone the
  // moment somebody else signs in on this tab.
  if (String(parsed.user ?? '') !== String(userEmail ?? '')) {
    clearPersistedCampaignForm();
    return null;
  }

  const fields = {};
  for (const key of PERSISTED_FIELDS) {
    const value = parsed.fields[key];
    // Empty strings are copied across on purpose: a field the operator cleared must
    // stay cleared, not fall back to a default.
    if (typeof value === 'string') fields[key] = value;
  }

  return fields;
}

/** @param {string} userEmail @param {object} fields */
export function writePersistedCampaignForm(userEmail, fields) {
  const payload = {
    version: SCHEMA_VERSION,
    user: String(userEmail ?? ''),
    savedAt: new Date().toISOString(),
    fields: {}
  };

  for (const key of PERSISTED_FIELDS) {
    const value = fields?.[key];
    payload.fields[key] = value === undefined || value === null ? '' : String(value);
  }

  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Quota exceeded, or storage blocked. The draft is a convenience; losing it must
    // not interrupt whatever the operator is doing.
  }
}

export function clearPersistedCampaignForm() {
  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* nothing to do */
  }
}
