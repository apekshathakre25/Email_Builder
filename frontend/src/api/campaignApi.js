import { api } from '../lib/apiClient';

/**
 * The campaign send lifecycle.
 *
 * Progress is HTTP polling. There is no SSE or websocket endpoint on the backend,
 * so `getCampaignStatus` is the only way to observe a running campaign; /status has
 * its own 600/min rate bucket precisely so this polling cannot starve a send.
 */

/**
 * The exact request-body keys POST /send-email destructures.
 *
 * Spelled out as a map because they are kebab-case HTML input names, not
 * JavaScript identifiers, and getting one wrong fails silently: the server reads
 * `undefined`, so a typo'd `smtp-host` produces a connection error rather than a
 * validation error naming the field.
 */
export const SEND_FIELD_NAMES = Object.freeze({
  smtpHost: 'smtp-host',
  smtpPort: 'smtp-port',
  smtpUser: 'smtp-user',
  smtpPass: 'smtp-pass',
  mode: 'test-bulk',
  testRecipients: 'test-recp',
  limit: 'limit',
  intervalSeconds: 'interval-seconds',
  fromName: 'smtp-from-name',
  fromEmail: 'smtp-from-email',
  subject: 'subject',
  customHeaders: 'custom-headers',
  customMessageId: 'custom-message-id',
  inboxPatternId: 'inbox-pattern-id',
  messageType: 'plain-html',
  message: 'message',
  fileIds: 'file-ids',
  limitToSend: 'limit-to-send',
  autoImapTest: 'auto-imap-test',
  sessionId: 'sessionId'
});

/**
 * Whether a saved SMTP password exists for this operator.
 *
 * The password itself never leaves the server. This only reports that one is
 * stored, so the UI can explain that sending will reuse it and that leaving the
 * field blank is deliberate rather than an omission.
 *
 * @returns {Promise<{success: boolean, hasSmtpPass: boolean}>}
 */
export function getEmailConfig(signal) {
  return api.get('/email-config', { signal });
}

/**
 * Stores or clears the SMTP password.
 *
 * The server's three-way contract, preserved here because it is what makes an
 * autosave safe:
 *   key absent       -> leave the stored password alone
 *   non-empty string -> encrypt and replace
 *   empty string     -> the operator cleared the field, so clear the stored one
 *
 * This function always sends the key, so calling it with '' is an explicit
 * "forget the saved password". To mean "no change", do not call it.
 */
export function saveSmtpPassword(smtpPass, { keepalive = false } = {}) {
  if (keepalive) {
    // Flushed while the page is going away (pagehide), where fetch() without
    // keepalive is cancelled mid-flight. Hand-rolled rather than routed through
    // the shared client because keepalive is not one of its options and this is
    // the only call that needs it.
    return fetch(`${import.meta.env.VITE_API_BASE_URL ?? ''}/email-config`, {
      method: 'POST',
      credentials: 'include',
      keepalive: true,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-Requested-With': 'XMLHttpRequest'
      },
      body: JSON.stringify({ smtpPass })
    });
  }

  return api.post('/email-config', { smtpPass });
}

/**
 * Submits a batch.
 *
 * Posted as urlencoded, matching what the EJS frontend sent. The server parses
 * JSON on this route too, but urlencoded is the shape it has always received and
 * there is nothing to gain from changing it — `limit` and friends are strings
 * either way, since they come from text inputs.
 *
 * The 200 is returned *before* the jobs are written to Bull: enqueueing happens in
 * a setImmediate, in chunks, re-checking the stop marker between them. So
 * `{status:'enqueued'}` means "accepted", not "queued", and the counters only start
 * moving on subsequent /status polls.
 *
 * @param {Record<string, string>} fields Keyed by the SEND_FIELD_NAMES values.
 * @returns {Promise<{status: string, batchCount: number, testIds?: string[]}>}
 */
export function sendEmail(fields) {
  const body = new URLSearchParams();

  for (const [key, value] of Object.entries(fields)) {
    // Empty string is meaningful and must be sent: an empty `smtp-pass` is how
    // the form asks the server to use the saved credential, and an empty
    // `interval-seconds` is how it asks for an unpaced campaign. Only genuinely
    // absent values are dropped.
    if (value === undefined || value === null) continue;
    body.append(key, String(value));
  }

  return api.post('/send-email', body);
}

/**
 * One progress reading.
 *
 * Field meanings that are not obvious from the names:
 *   sending   enqueued but not yet settled (sentIndex - sent - failed - resendQueued)
 *   pending   never attempted (total - sent - failed) — server-computed on purpose,
 *             because the old UI derived it locally and the two disagreed
 *   stopped   read from the Redis stop marker, not from EmailLog.status, so it
 *             reflects what the workers actually obey and picks up a stop issued
 *             in another tab or by another operator
 *   rateLimit null for an unpaced campaign — the signal not to show interval UI
 *   window    live bucket state; `resetInMs` anchors the countdown
 *
 * @returns {Promise<{total: number, sent: number, failed: number, sending: number,
 *   pending: number, sentIndex: number, lastError: string, stopped: boolean,
 *   stoppedAt: string|null, stoppedBy: string, campaignStatus: string|null,
 *   resendQueued: number, rateLimit: {limit: number, intervalSeconds: number}|null,
 *   window: {used: number, limit: number, resetInMs: number}|null}>}
 */
export function getCampaignStatus(sessionId, signal) {
  return api.get('/status', { query: { sessionId }, signal });
}

/**
 * Halts a campaign.
 *
 * Idempotent by construction — the stop marker is written with SET NX — so a double
 * click, two tabs, or both stop buttons at once produce one stop. A repeat comes
 * back with `alreadyStopped: true`.
 *
 * Remaining recipients stay pending and resumable: sending them later is another
 * /send-email for the same sessionId, which lifts the marker and drains the resend
 * backlog first. There is no separate resume endpoint.
 *
 * @returns {Promise<{status: string, sessionId: string, alreadyStopped: boolean,
 *   stoppedAt: string, stoppedBy: string, sent: number, failed: number,
 *   pending: number, total: number, message: string}>}
 */
export function stopSending(sessionId) {
  return api.post('/stop-sending', { sessionId });
}
