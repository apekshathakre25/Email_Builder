'use strict';

const PROTECTED_HEADER_NAMES = new Set([
  'authentication-results',
  'delivery-date',
  'dkim-signature',
  'domainkey-signature',
  'final-recipient',
  'original-recipient',
  'received',
  'received-spf',
  'return-path'
]);

const INBOX_PATTERN_OWNED_HEADER_NAMES = new Set([
  'content-transfer-encoding',
  'content-type',
  'date',
  'message-id',
  'mime-version'
]);

const ALLOWED_MAIL_OPTION_KEYS = new Set([
  'from',
  'to',
  'subject',
  'messageId',
  'date',
  'text',
  'html',
  'baseBoundary',
  'boundaryPrefix',
  'textEncoding'
]);

function isProtectedHeader(name) {
  const normalized = String(name || '').trim().toLowerCase();
  return PROTECTED_HEADER_NAMES.has(normalized) ||
    normalized.startsWith('arc-') ||
    normalized.startsWith('x-');
}

function isInboxPatternHeaderBlocked(name) {
  const normalized = String(name || '').trim().toLowerCase();
  return isProtectedHeader(normalized) || INBOX_PATTERN_OWNED_HEADER_NAMES.has(normalized);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;

  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

const INBOX_PATTERNS = deepFreeze([
  {
    id: 'pattern-1',
    name: 'Pattern 1',
    description: 'UTF-8 multipart alternative with quoted-printable text and HTML.',
    mailOptions: {
      from: { name: '{{FromName}}', address: '{{FromEmail}}' },
      to: { name: '{{ToName}}', address: '{{ToEmail}}' },
      subject: '{{SubjectLine}}',
      messageId: '<[[time()]].[[num(5)]].[[num(10)]].[[smallchar(4)]]@{{Domain}}>',
      date: '[[RFC_Date_UTC]]',
      text: {
        content: '{{PlainContent}}',
        contentType: 'text/plain; charset=utf-8',
        contentTransferEncoding: 'quoted-printable'
      },
      html: {
        content: '{{HtmlContent}}',
        contentType: 'text/html; charset=utf-8',
        contentTransferEncoding: 'quoted-printable'
      },
      baseBoundary: 'b1_[[mixall(24)]]',
      boundaryPrefix: '--_Opterite',
      textEncoding: 'Q'
    }
  },
  {
    id: 'pattern-2',
    name: 'Pattern 2',
    description: 'UTF-8 multipart alternative with base64 text and quoted-printable HTML.',
    mailOptions: {
      from: { name: '{{FromName}}', address: '{{FromEmail}}' },
      to: { name: '{{ToName}}', address: '{{ToEmail}}' },
      subject: '{{SubjectLine}}',
      messageId: '<[[mixsmallalphanum(12)]].[[mixall(10)]].[[time()]]@{{Domain}}>',
      date: '[[RFC_Date_IST]]',
      text: {
        content: '{{PlainContent}}',
        contentType: 'text/plain; charset=utf-8',
        contentTransferEncoding: 'base64'
      },
      html: {
        content: '{{HtmlContent}}',
        contentType: 'text/html; charset=utf-8',
        contentTransferEncoding: 'quoted-printable'
      },
      baseBoundary: 'alt_[[hexdigit(28)]]',
      boundaryPrefix: '--_Opterite',
      textEncoding: 'B'
    }
  },
  {
    id: 'pattern-3',
    name: 'Pattern 3',
    description: 'UTF-8 multipart alternative with base64 text and HTML.',
    mailOptions: {
      from: { name: '{{FromName}}', address: '{{FromEmail}}' },
      to: { name: '{{ToName}}', address: '{{ToEmail}}' },
      subject: '{{SubjectLine}}',
      messageId: '<[[mixbigalphanum(19)]]_[[bigchar(8)]]_[[time()]]@{{FromDomain}}>',
      date: '[[RFC_Date_EDT]]',
      text: {
        content: '{{PlainContent}}',
        contentType: 'text/plain; charset=utf-8',
        contentTransferEncoding: 'base64'
      },
      html: {
        content: '{{HtmlContent}}',
        contentType: 'text/html; charset=utf-8',
        contentTransferEncoding: 'base64'
      },
      baseBoundary: 'mime_[[mixbigalphanum(30)]]',
      boundaryPrefix: '--_Opterite',
      textEncoding: 'B'
    }
  }
]);

function assertCatalog() {
  const ids = new Set();

  for (const pattern of INBOX_PATTERNS) {
    if (!/^pattern-[1-3]$/.test(pattern.id) || ids.has(pattern.id)) {
      throw new Error(`Invalid or duplicate inbox pattern id: ${pattern.id}`);
    }
    ids.add(pattern.id);

    if (!pattern.name || !pattern.description || !pattern.mailOptions) {
      throw new Error(`Inbox pattern ${pattern.id} is missing required catalog data`);
    }

    for (const key of Object.keys(pattern.mailOptions)) {
      if (!ALLOWED_MAIL_OPTION_KEYS.has(key)) {
        throw new Error(`Inbox pattern ${pattern.id} contains unsupported mail option: ${key}`);
      }
    }

    const headers = pattern.mailOptions.headers || {};
    for (const headerName of Object.keys(headers)) {
      if (isProtectedHeader(headerName)) {
        throw new Error(`Inbox pattern ${pattern.id} contains protected header: ${headerName}`);
      }
    }
  }

  if (ids.size !== 3) {
    throw new Error('Inbox pattern catalog must contain exactly three profiles');
  }
}

assertCatalog();

function getInboxPattern(id) {
  return INBOX_PATTERNS.find((pattern) => pattern.id === id) || null;
}

function listInboxPatternMetadata() {
  return INBOX_PATTERNS.map(({ id, name, description }) => ({ id, name, description }));
}

module.exports = {
  INBOX_PATTERNS,
  getInboxPattern,
  isInboxPatternHeaderBlocked,
  isProtectedHeader,
  listInboxPatternMetadata
};
