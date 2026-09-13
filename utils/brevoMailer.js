'use strict';

const env = require('../config/env');

const BREVO_ENDPOINT = 'https://api.brevo.com/v3/smtp/email';
const REQUEST_TIMEOUT_MS = 15000;

class BrevoConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BrevoConfigurationError';
    this.isConfigurationError = true;
  }
}

class BrevoApiError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.name = 'BrevoApiError';
    this.status = status;
    this.code = code;
  }
}

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

function isConfigured() {
  try {
    assertConfigured();
    return true;
  } catch (err) {
    if (err.isConfigurationError) return false;
    throw err;
  }
}

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

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(BREVO_ENDPOINT, {
      method: 'POST',
      headers: {

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
