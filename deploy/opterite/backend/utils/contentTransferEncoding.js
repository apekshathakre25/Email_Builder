'use strict';

const quotedPrintable = require('nodemailer/lib/qp');
const MimeNode = require('nodemailer/lib/mime-node');

const CONTENT_TRANSFER_ENCODINGS = Object.freeze([
  '7bit',
  '8bit',
  'binary',
  'base64',
  'quoted-printable'
]);

const CONTENT_TRANSFER_ENCODING_SET = new Set(CONTENT_TRANSFER_ENCODINGS);
const BINARY_SMTP_TRANSPORT_CAPABILITY = Object.freeze({
  mimeHeaderSupported: true,
  trueBinaryTransportSupported: false,
  requiredExtensions: Object.freeze(['BINARYMIME', 'CHUNKING']),
  reason: 'The current Nodemailer SMTP transport does not implement BINARYMIME/CHUNKING.'
});

function normalizeContentTransferEncoding(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return CONTENT_TRANSFER_ENCODING_SET.has(normalized) ? normalized : null;
}

function assertValidContentTransferEncoding(value, fieldName = 'Content Transfer Encoding') {
  const normalized = normalizeContentTransferEncoding(value);
  if (!normalized) {
    throw new Error(`${fieldName} must be one of: ${CONTENT_TRANSFER_ENCODINGS.join(', ')}`);
  }
  return normalized;
}

function validateBodyForContentTransferEncoding(body, encoding) {
  const bytes = Buffer.from(String(body || ''), 'utf8');
  const lines = bytes.toString('utf8').split(/\r\n|\n|\r/);

  if (encoding === '7bit' && bytes.some((byte) => byte > 0x7f)) {
    throw new Error('7bit content must contain ASCII bytes only');
  }

  if (encoding === '7bit' || encoding === '8bit') {
    if (bytes.includes(0)) {
      throw new Error(`${encoding} content must not contain NUL bytes`);
    }
    if (lines.some((line) => Buffer.byteLength(line, 'utf8') > 998)) {
      throw new Error(`${encoding} content must not contain lines longer than 998 bytes`);
    }
  }

  return bytes;
}

function wrapBase64(value) {
  const encoded = Buffer.from(value, 'utf8').toString('base64');
  return (encoded.match(/.{1,76}/g) || []).join('\r\n');
}

function encodeMimeBody(body, encoding) {
  const value = String(body || '');
  validateBodyForContentTransferEncoding(value, encoding);

  if (encoding === 'base64') return wrapBase64(value);
  if (encoding === 'quoted-printable') return quotedPrintable.encode(value);

  return value.replace(/\r?\n|\r/g, '\r\n');
}

function createMimePart(body, contentType, encoding) {
  return {
    raw: [
      `Content-Type: ${contentType}`,
      `Content-Transfer-Encoding: ${encoding}`,
      '',
      encodeMimeBody(body, encoding)
    ].join('\r\n'),
    contentType,
    contentTransferEncoding: encoding
  };
}

function getContentTransferEncodingCapability(encoding) {
  return normalizeContentTransferEncoding(encoding) === 'binary'
    ? BINARY_SMTP_TRANSPORT_CAPABILITY
    : null;
}

function prepareContentTransferEncodingMessage(message, encoding, rawPlainTextPart) {
  let preparedMessage = message;

  if (rawPlainTextPart) {
    const root = new MimeNode('multipart/mixed', {
      newline: message.newline
    });
    const rootHeaders = message._headers.filter(({ key }) => {
      const normalizedKey = key.toLowerCase();
      return normalizedKey !== 'content-type' &&
        normalizedKey !== 'content-transfer-encoding';
    });

    root.addHeader(rootHeaders);
    root.keepBcc = message.keepBcc;
    root.setEnvelope(message.getEnvelope());
    root.createChild().setRaw(rawPlainTextPart);
    preparedMessage = root;
  }

  if (encoding === '8bit') {
    preparedMessage.setEnvelope({
      ...preparedMessage.getEnvelope(),
      use8BitMime: true
    });
  }

  return preparedMessage;
}

function configureContentTransferEncodingMessage(mail) {
  const textPart = mail.data.text;
  const htmlPart = mail.data.html;
  const encoding = normalizeContentTransferEncoding(
    (htmlPart && htmlPart.contentTransferEncoding) ||
    (textPart && textPart.contentTransferEncoding)
  );

  if (!encoding) return null;

  const hasAttachments = Array.isArray(mail.data.attachments) &&
    mail.data.attachments.length > 0;
  const rawPlainTextPart = !htmlPart &&
    !hasAttachments &&
    textPart &&
    typeof textPart === 'object' &&
    typeof textPart.raw === 'string'
    ? textPart.raw
    : null;

  mail.message = prepareContentTransferEncodingMessage(
    mail.message,
    encoding,
    rawPlainTextPart
  );

  return encoding;
}

module.exports = {
  CONTENT_TRANSFER_ENCODINGS,
  assertValidContentTransferEncoding,
  configureContentTransferEncodingMessage,
  createMimePart,
  encodeMimeBody,
  getContentTransferEncodingCapability,
  normalizeContentTransferEncoding,
  prepareContentTransferEncodingMessage,
  validateBodyForContentTransferEncoding
};