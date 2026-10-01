/**
 * Client-side validation for the send-rate and per-action cap.
 *
 * ── What this is for, and what it is not ─────────────────────────────────────
 *
 * The server is authoritative. `parseRateLimitConfig` in backend/utils/emailRateLimiter.js
 * and `parseLimitToSend` in backend/routes/sendemails.js re-check every value and reject with
 * a 400. This exists only so a typo is reported instantly rather than costing a round
 * trip, and so the operator is not sent to the back of the campaign queue to be told
 * about a mistyped number.
 *
 * The bounds are passed in from /api/app-config rather than hardcoded. The old
 * frontend kept its own copies with a comment admitting they were duplicated from the
 * server and would drift — this removes the duplicate rather than relocating it.
 *
 * Messages are reproduced verbatim from the previous implementation. Operators have
 * read these strings for a long time and there is nothing to gain from rewording them.
 */

/** Normalises a form value to a trimmed string. */
function asText(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

/**
 * Validates the Limit / Interval pair.
 *
 * Both empty is valid and means "no rate limit", which is how every campaign behaved
 * before the interval field existed. An interval without a limit is the one
 * combination that is an error: the limit is what the interval is a window *for*, so
 * an interval alone does not describe a rate.
 *
 * @returns {string} An error message, or '' when valid.
 */
export function validateSendRate(limitRaw, intervalRaw, bounds) {
  const limitBounds = bounds?.rateLimit ?? { min: 1, max: 1_000_000 };
  const intervalBounds = bounds?.rateIntervalSeconds ?? { min: 0.1, max: 3600 };

  const limit = asText(limitRaw);
  const interval = asText(intervalRaw);

  if (limit !== '') {
    // Number(), not parseInt(): parseInt('35abc') is 35, which would accept a typo as
    // a valid rate and silently send at a rate nobody asked for.
    const value = Number(limit);

    if (!Number.isInteger(value)) {
      return `Limit must be a whole number of emails (got "${limit}").`;
    }
    if (value < limitBounds.min || value > limitBounds.max) {
      return `Limit must be between ${limitBounds.min} and ${limitBounds.max}.`;
    }
  }

  if (interval === '') return '';

  const seconds = Number(interval);

  if (!Number.isFinite(seconds)) {
    return `Interval (seconds) must be a number (got "${interval}").`;
  }
  if (seconds < intervalBounds.min || seconds > intervalBounds.max) {
    return `Interval (seconds) must be between ${intervalBounds.min} and ${intervalBounds.max}.`;
  }
  if (limit === '') {
    return 'Interval (seconds) needs a Limit — Limit is how many emails each interval allows.';
  }

  return '';
}

/**
 * Validates Limit to Send — the cap on one Send Email action.
 *
 * Deliberately independent of the rate check: this is a batch size, not a second
 * rate, so it neither requires nor constrains Limit and Interval. Empty means no cap.
 *
 * @returns {string} An error message, or '' when valid.
 */
export function validateLimitToSend(raw, bounds) {
  const limits = bounds?.limitToSend ?? { min: 1, max: 10_000_000 };
  const text = asText(raw);

  if (text === '') return '';

  const value = Number(text);

  if (!Number.isInteger(value)) {
    return `Limit to Send must be a whole number of emails (got "${text}").`;
  }
  if (value < limits.min) {
    return `Limit to Send must be at least ${limits.min} — leave it empty for no limit (got ${value}).`;
  }
  if (value > limits.max) {
    return `Limit to Send must be ${limits.max} or less (got ${value}).`;
  }

  return '';
}

/**
 * Validation that must pass before a submission is worth queueing.
 *
 * Ordered so the operator sees the most structural problem first: a bulk campaign
 * with no file ids has nothing to send at all, which matters more than a mistyped rate.
 *
 * @returns {{ok: boolean, error: string, field: string|null}}
 */
export function validateCampaignForm(form, bounds) {
  const isTest = form.testBulk === 'Test';

  if (isTest) {
    if (!asText(form.testRecipients)) {
      return {
        ok: false,
        field: 'testRecipients',
        error: 'Test recipients are required for a test send. Enter at least one email address.'
      };
    }
  } else {
    const fileIds = parseFileIds(form.fileIds);
    if (fileIds.length === 0) {
      return {
        ok: false,
        field: 'fileIds',
        error: 'File IDs are mandatory for bulk campaigns. Please add file IDs to proceed.'
      };
    }
  }

  const rateError = validateSendRate(form.limit, form.intervalSeconds, bounds);
  if (rateError) return { ok: false, field: 'limit', error: rateError };

  const limitToSendError = validateLimitToSend(form.limitToSend, bounds);
  if (limitToSendError) return { ok: false, field: 'limitToSend', error: limitToSendError };

  return { ok: true, error: '', field: null };
}

/**
 * Splits the File IDs field.
 *
 * The first id is significant beyond being first: it becomes the campaign's
 * sessionId, so it is what /status is polled with, what /stop-sending halts and what
 * the campaign lane is keyed on.
 */
export function parseFileIds(raw) {
  return asText(raw)
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
}

/** Splits Test Recipients on the same separators the server accepts. */
export function parseTestRecipients(raw) {
  return asText(raw)
    .split(/[,;\n\r]+/)
    .map((email) => email.trim())
    .filter(Boolean);
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(email) {
  return EMAIL_PATTERN.test(String(email ?? '').trim());
}
