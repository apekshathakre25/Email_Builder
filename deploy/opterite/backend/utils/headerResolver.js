'use strict';

const { isProtectedHeader } = require('../config/inboxPatterns');
const {
  assertValidContentTransferEncoding
} = require('./contentTransferEncoding');

const OVERRIDE_HEADER_NAMES = new Set(['from', 'subject']);

class HeaderValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'HeaderValidationError';
  }
}

function isValidHeaderName(name) {
  return /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name);
}

function isUserProtectedHeader(name) {
  const normalized = String(name || '').trim().toLowerCase();
  if (normalized.startsWith('x-')) {
    return new Set([
      'x-google-dkim-signature',
      'x-sg-eid',
      'x-ses-outgoing'
    ]).has(normalized);
  }
  return isProtectedHeader(normalized);
}

function setHeader(headers, name, value) {
  const normalized = name.toLowerCase();
  const existingName = Object.keys(headers).find(
    (key) => key.toLowerCase() === normalized
  );

  if (existingName) delete headers[existingName];
  headers[name] = value;
}

function parseCustomHeaders(rawHeaders) {
  if (rawHeaders === undefined || rawHeaders === null || !String(rawHeaders).trim()) {
    return {};
  }

  const headers = {};
  const lines = String(rawHeaders).split(/\r?\n/);

  lines.forEach((line, index) => {
    if (!line.trim()) return;

    const separator = line.indexOf(':');
    const name = separator < 0 ? '' : line.slice(0, separator).trim();
    if (separator < 1 || !isValidHeaderName(name)) {
      throw new HeaderValidationError(`Malformed custom header on line ${index + 1}`);
    }

    if (isUserProtectedHeader(name)) {
      throw new HeaderValidationError(`Custom header "${name}" is not supported`);
    }

    const value = line.slice(separator + 1).trim();
    if (value) setHeader(headers, name, value);
  });

  return headers;
}

function resolveCampaignHeaders({ headers = {}, formFrom, formSubject, generatedFrom, generatedSubject }) {
  const resolvedHeaders = {};
  let headerFrom;
  let headerSubject;
  let headerContentTransferEncoding;

  for (const [name, rawValue] of Object.entries(headers || {})) {
    const value = rawValue === undefined || rawValue === null ? '' : String(rawValue).trim();
    if (!value) continue;

    if (isUserProtectedHeader(name)) {
      throw new HeaderValidationError(`Custom header "${name}" is not supported`);
    }

    const normalized = name.toLowerCase();
    if (normalized === 'from') headerFrom = value;
    else if (normalized === 'subject') headerSubject = value;
    else if (normalized === 'content-transfer-encoding') {
      headerContentTransferEncoding = assertValidContentTransferEncoding(value, name);
    }
    else setHeader(resolvedHeaders, name, value);
  }

  const result = {
    from: headerFrom || formFrom || generatedFrom,
    subject: headerSubject || formSubject || generatedSubject,
    headers: resolvedHeaders
  };

  if (headerContentTransferEncoding) {
    result.contentTransferEncoding = headerContentTransferEncoding;
  }

  return result;
}

module.exports = {
  HeaderValidationError,
  OVERRIDE_HEADER_NAMES,
  parseCustomHeaders,
  resolveCampaignHeaders
};