'use strict';

/**
 * Transactional email through the Brevo HTTP API.
 *
 * Replaces the Brevo SMTP relay that used to deliver login OTPs. One HTTPS
 * request per message means there is no SMTP handshake to wait on, no
 * connection to keep alive, and no SMTP username/password pair to store —
 * only an API key.
 *
 * The key is read from the validated config (BREVO_API_KEY). It is never
 * logged, never returned to a client, and stripped from any error text before
 * that text leaves this module.
 */

const env = require('../config/env');

const BREVO_ENDPOINT = 'https://api.brevo.com/v3/smtp/email';
const REQUEST_TIMEOUT_MS = 15000;

/**
 * The deployment is misconfigured (no API key, no sender). Distinct from a send
 * failure so callers can say so plainly instead of reporting a transient error
 * or, worse, reporting success.
 */
class BrevoConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BrevoConfigurationError';
    this.isConfigurationError = true;
  }
}

/** Brevo received the request and refused it, or was unreachable. */
class BrevoApiError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.name = 'BrevoApiError';
    this.status = status;
    this.code = code;
  }
}

/**
 * Last line of defence before any Brevo text is logged or returned. Brevo does
 * not echo the key back today, but error strings are provider-controlled input
 * and this module's output reaches both the logs and the HTTP response.
 */
function redactSecrets(text) {
  if (text === undefined || text === null) return '';

  let safe = String(text);

  const apiKey = env.brevo.apiKey;
  if (apiKey) {
    safe = safe.split(apiKey).join('[redacted]');
  }

  // Brevo keys are "xkeysib-<hex>-<suffix>"; SMTP keys use the xsmtpsib- prefix.
  return safe.replace(/x(?:keysib|smtpsib)-[A-Za-z0-9._-]+/gi, '[redacted]');
}

/**
 * Throws instead of returning a boolean: a missing key must never be able to
 * fall through to a success path.
 */
function assertConfigured() {
  if (!env.brevo.apiKey || !String(env.brevo.apiKey).trim()) {
    throw new BrevoConfigurationError(
      'BREVO_API_KEY is not set, so no email can be sent'
    );
  }

  if (!env.brevo.senderEmail || !String(env.brevo.senderEmail).trim()) {
    throw new BrevoConfigurationError(
      'SMTP_FROM_EMAIL is not set; Brevo requires a sender address that is verified on the account'
    );
  }
}

/** True when the API key and sender are both present. */
function isConfigured() {
  try {
    assertConfigured();
    return true;
  } catch (err) {
    if (err.isConfigurationError) return false;
    throw err;
  }
}

/**
 * Pulls the most useful message out of a Brevo error body. Brevo replies with
 * { code, message } on failure, but returns HTML for some gateway errors, so
 * fall back to the status line rather than dumping a page into the log.
 */
function describeFailure(status, statusText, body) {
  if (body && typeof body === 'object') {
    const parts = [];
    if (body.message) parts.push(String(body.message));
    if (body.code) parts.push(`code: ${body.code}`);
    if (parts.length > 0) {
      return `Brevo API ${status}: ${parts.join(' ')}`;
    }
  }

  return `Brevo API ${status}${statusText ? ` ${statusText}` : ''}`;
}

/**
 * Sends one transactional email.
 *
 * @param {object}  message
 * @param {string}  message.to       Recipient address.
 * @param {string} [message.toName]  Recipient display name.
 * @param {string}  message.subject
 * @param {string}  message.html     Rendered HTML body.
 * @param {string} [message.text]    Optional plain-text alternative.
 * @returns {Promise<{ messageId: string|undefined }>}
 * @throws {BrevoConfigurationError} Key or sender missing.
 * @throws {BrevoApiError}           Brevo rejected the message or was unreachable.
 */
async function sendTransactionalEmail({ to, toName, subject, html, text } = {}) {
  assertConfigured();

  if (!to || !String(to).trim()) {
    throw new BrevoConfigurationError('A recipient address is required');
  }

  const payload = {
    sender: {
      name: env.brevo.senderName,
      email: env.brevo.senderEmail
    },
    to: [toName ? { email: to, name: toName } : { email: to }],
    subject,
    htmlContent: html
  };

  if (text) {
    payload.textContent = text;
  }

  // Node's fetch has no default timeout; without this a stalled connection
  // would hold the request open until the client gives up.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(BREVO_ENDPOINT, {
      method: 'POST',
      headers: {
        // Brevo authenticates on this header, not Authorization.
        'api-key': env.brevo.apiKey,
        accept: 'application/json',
        'content-type': 'application/json'
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
  } catch (err) {
    const reason = err.name === 'AbortError'
      ? `no response within ${REQUEST_TIMEOUT_MS}ms`
      : redactSecrets(err.message);
    throw new BrevoApiError(`Could not reach the Brevo API (${reason})`);
  } finally {
    clearTimeout(timeout);
  }

  const raw = await response.text().catch(() => '');

  let body = null;
  if (raw) {
    try {
      body = JSON.parse(raw);
    } catch {
      body = null;
    }
  }

  if (!response.ok) {
    throw new BrevoApiError(
      redactSecrets(describeFailure(response.status, response.statusText, body || raw)),
      { status: response.status, code: body?.code }
    );
  }

  return { messageId: body?.messageId };
}

module.exports = {
  sendTransactionalEmail,
  isConfigured,
  assertConfigured,
  redactSecrets,
  BrevoConfigurationError,
  BrevoApiError,
  BREVO_ENDPOINT
};
