'use strict';

const quotedPrintable = require('nodemailer/lib/qp');
const { getInboxPattern } = require('../config/inboxPatterns');

const MAX_GENERATED_LENGTH = 256;
const MESSAGE_ID_PATTERN = /^<[^<>@\s]+@[^<>@\s]+>$/;
const BOUNDARY_PATTERN = /^[A-Za-z0-9'()+_,\-./:=?]+$/;

const RANDOM_CHARSETS = Object.freeze({
  num: '0123456789',
  smallchar: 'abcdefghijklmnopqrstuvwxyz',
  bigchar: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  mixall: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
  mixsmallalphanum: 'abcdefghijklmnopqrstuvwxyz0123456789',
  mixbigalphanum: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
  hexdigit: '0123456789abcdef'
});

const NORMAL_PLACEHOLDERS = Object.freeze([
  'ToEmail',
  'ToName',
  'FromName',
  'FromEmail',
  'SubjectLine',
  'MessageId',
  'PlainContent',
  'HtmlContent',
  'Domain',
  'FromDomain'
]);

class InboxPatternRenderError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InboxPatternRenderError';
    this.code = 'INVALID_INBOX_PATTERN';
  }
}

function asDate(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new InboxPatternRenderError('Pattern renderer received an invalid clock value');
  }
  return date;
}

function formatRfcDate(date, timezone) {
  const offsets = { UTC: 0, IST: 330, EST: -300, EDT: -240 };
  const offsetMinutes = offsets[timezone];
  const shifted = new Date(date.getTime() + offsetMinutes * 60 * 1000);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const sign = offsetMinutes < 0 ? '-' : '+';
  const absoluteOffset = Math.abs(offsetMinutes);
  const offset = `${sign}${String(Math.floor(absoluteOffset / 60)).padStart(2, '0')}${String(absoluteOffset % 60).padStart(2, '0')}`;

  return `${days[shifted.getUTCDay()]}, ${String(shifted.getUTCDate()).padStart(2, '0')} ` +
    `${months[shifted.getUTCMonth()]} ${shifted.getUTCFullYear()} ` +
    `${String(shifted.getUTCHours()).padStart(2, '0')}:` +
    `${String(shifted.getUTCMinutes()).padStart(2, '0')}:` +
    `${String(shifted.getUTCSeconds()).padStart(2, '0')} ${offset}`;
}

function randomCharacters(charset, length, random) {
  let output = '';
  for (let index = 0; index < length; index++) {
    const value = random();
    if (!Number.isFinite(value) || value < 0 || value >= 1) {
      throw new InboxPatternRenderError('Pattern random source must return a number from 0 up to 1');
    }
    output += charset[Math.floor(value * charset.length)];
  }
  return output;
}

function resolveExpression(expression, { now, random }) {
  const normalized = expression.trim();

  if (normalized === 'time()') {
    return String(Math.floor(now.getTime() / 1000));
  }

  const rfcDateMatch = normalized.match(/^RFC_Date_(UTC|IST|EST|EDT)(?:\(\))?$/);
  if (rfcDateMatch) {
    return formatRfcDate(now, rfcDateMatch[1]);
  }

  const generatedMatch = normalized.match(/^([A-Za-z]+)\(([^()]*)\)$/);
  if (!generatedMatch) {
    throw new InboxPatternRenderError(`Malformed or unknown pattern expression: [[${expression}]]`);
  }

  const functionName = generatedMatch[1].toLowerCase();
  const charset = RANDOM_CHARSETS[functionName];
  if (!charset) {
    throw new InboxPatternRenderError(`Unknown pattern expression: ${generatedMatch[1]}`);
  }

  if (!/^\d+$/.test(generatedMatch[2])) {
    throw new InboxPatternRenderError(`Pattern expression ${generatedMatch[1]} requires an integer length`);
  }

  const length = Number(generatedMatch[2]);
  if (length < 1 || length > MAX_GENERATED_LENGTH) {
    throw new InboxPatternRenderError(
      `Pattern expression ${generatedMatch[1]} length must be between 1 and ${MAX_GENERATED_LENGTH}`
    );
  }

  return randomCharacters(charset, length, random);
}

function encodedPlaceholderValue(name, values) {
  const encodedMatch = name.match(/^(PlainContent|HtmlContent)_(base64|qp)$/);
  if (!encodedMatch) return null;

  const source = values[encodedMatch[1]];
  if (source === undefined || source === null) {
    throw new InboxPatternRenderError(`Missing value for pattern placeholder: ${encodedMatch[1]}`);
  }

  const text = String(source);
  return encodedMatch[2] === 'base64'
    ? Buffer.from(text, 'utf8').toString('base64')
    : quotedPrintable.encode(text);
}

function resolvePlaceholder(name, values) {
  const encoded = encodedPlaceholderValue(name, values);
  if (encoded !== null) return encoded;

  if (!NORMAL_PLACEHOLDERS.includes(name)) {
    throw new InboxPatternRenderError(`Unknown pattern placeholder: {{${name}}}`);
  }

  const value = values[name];
  if (value === undefined || value === null) {
    throw new InboxPatternRenderError(`Missing value for pattern placeholder: ${name}`);
  }

  return String(value);
}

function renderTemplate(template, values, options = {}) {
  if (typeof template !== 'string') {
    throw new InboxPatternRenderError('Pattern template must be a string');
  }
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    throw new InboxPatternRenderError('Pattern placeholder values must be an object');
  }

  const context = {
    now: asDate(options.now === undefined ? Date.now() : options.now),
    random: options.random || Math.random
  };
  if (typeof context.random !== 'function') {
    throw new InboxPatternRenderError('Pattern random source must be a function');
  }

  let rendered = '';

  for (let index = 0; index < template.length;) {
    const opener = template.slice(index, index + 2);

    if (opener === '}}' || opener === ']]') {
      throw new InboxPatternRenderError('Malformed or unresolved pattern syntax remains after rendering');
    }

    if (opener !== '{{' && opener !== '[[') {
      rendered += template[index];
      index += 1;
      continue;
    }

    const closer = opener === '{{' ? '}}' : ']]';
    const end = template.indexOf(closer, index + 2);
    if (end < 0) {
      throw new InboxPatternRenderError('Malformed or unresolved pattern syntax remains after rendering');
    }

    const token = template.slice(index + 2, end);
    const invalidTokenCharacter = opener === '{{' ? /[{}]/ : /[\[\]]/;
    if (!token || invalidTokenCharacter.test(token)) {
      throw new InboxPatternRenderError('Malformed or unresolved pattern syntax remains after rendering');
    }

    rendered += opener === '{{'
      ? resolvePlaceholder(token.trim(), values)
      : resolveExpression(token, context);
    index = end + 2;
  }

  return rendered;
}

function renderNode(value, values, options) {
  if (typeof value === 'string') return renderTemplate(value, values, options);
  if (Array.isArray(value)) return value.map((entry) => renderNode(entry, values, options));
  if (!value || typeof value !== 'object') return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, renderNode(entry, values, options)])
  );
}

function assertSingleLineHeader(name, value) {
  if (typeof value === 'string' && /[\r\n]/.test(value)) {
    throw new InboxPatternRenderError(`Rendered ${name} must not contain line breaks`);
  }
}

function validateRenderedOptions(mailOptions) {
  for (const [name, value] of [
    ['From name', mailOptions.from?.name],
    ['From address', mailOptions.from?.address],
    ['To name', mailOptions.to?.name],
    ['To address', mailOptions.to?.address],
    ['Subject', mailOptions.subject],
    ['Date', mailOptions.date],
    ['Message-ID', mailOptions.messageId]
  ]) {
    assertSingleLineHeader(name, value);
  }

  if (!MESSAGE_ID_PATTERN.test(mailOptions.messageId || '')) {
    throw new InboxPatternRenderError('Rendered Message-ID is invalid');
  }

  for (const [name, value] of [
    ['base boundary', mailOptions.baseBoundary],
    ['boundary prefix', mailOptions.boundaryPrefix]
  ]) {
    if (typeof value !== 'string' || !value || !BOUNDARY_PATTERN.test(value)) {
      throw new InboxPatternRenderError(`Rendered ${name} is invalid`);
    }
  }

  const finalBoundary = `${mailOptions.boundaryPrefix}-${mailOptions.baseBoundary}-Part_1`;
  if (finalBoundary.length > 70 || !BOUNDARY_PATTERN.test(finalBoundary)) {
    throw new InboxPatternRenderError('Rendered MIME boundary is invalid');
  }
}

function renderInboxPattern(patternId, values, options = {}) {
  const pattern = getInboxPattern(patternId);
  if (!pattern) {
    throw new InboxPatternRenderError(`Unknown inbox pattern: ${patternId}`);
  }

  const mailOptions = renderNode(pattern.mailOptions, values, options);
  validateRenderedOptions(mailOptions);
  return mailOptions;
}

module.exports = {
  InboxPatternRenderError,
  MAX_GENERATED_LENGTH,
  formatRfcDate,
  renderInboxPattern,
  renderTemplate
};
