'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const nodemailer = require('nodemailer');
const { simpleParser } = require('mailparser');

const {
  INBOX_PATTERNS,
  getInboxPattern,
  isInboxPatternHeaderBlocked,
  isProtectedHeader,
  listInboxPatternMetadata
} = require('../config/inboxPatterns');
const {
  InboxPatternRenderError,
  MAX_GENERATED_LENGTH,
  renderInboxPattern,
  renderTemplate
} = require('../services/inboxPatternRenderer');

const FIXED_NOW = new Date('2024-01-02T03:04:05.000Z');
const VALUES = Object.freeze({
  ToEmail: 'recipient@example.net',
  ToName: 'Recipient Name',
  FromName: 'Sender Name',
  FromEmail: 'sender@example.com',
  SubjectLine: 'Pattern subject',
  MessageId: '<provided@example.com>',
  PlainContent: 'Plain café content',
  HtmlContent: '<p>HTML café content</p>',
  Domain: 'example.com',
  FromDomain: 'example.com'
});

function deterministicOptions() {
  return { now: FIXED_NOW, random: () => 0 };
}

function headerNames(rawMessage) {
  const headerBlock = rawMessage.split(/\r?\n\r?\n/, 1)[0];
  return headerBlock
    .split(/\r?\n/)
    .filter((line) => line && !/^\s/.test(line) && line.includes(':'))
    .map((line) => line.slice(0, line.indexOf(':')));
}

test('catalog exposes three stable, deeply frozen safe profiles', () => {
  assert.deepEqual(INBOX_PATTERNS.map(({ id, name }) => ({ id, name })), [
    { id: 'pattern-1', name: 'Pattern 1' },
    { id: 'pattern-2', name: 'Pattern 2' },
    { id: 'pattern-3', name: 'Pattern 3' }
  ]);
  assert.equal(Object.isFrozen(INBOX_PATTERNS), true);
  assert.equal(Object.isFrozen(INBOX_PATTERNS[0].mailOptions.text), true);
  assert.equal(getInboxPattern('missing'), null);

  const metadata = listInboxPatternMetadata();
  assert.deepEqual(Object.keys(metadata[0]).sort(), ['description', 'id', 'name']);
  assert.equal('mailOptions' in metadata[0], false);
});

test('protected header predicate blocks transport, authentication, and provider headers', () => {
  for (const name of [
    'Received',
    'Authentication-Results',
    'ARC-Seal',
    'DKIM-Signature',
    'Return-Path',
    'Received-SPF',
    'X-Google-DKIM-Signature',
    'X-SG-EID',
    'X-SES-Outgoing'
  ]) {
    assert.equal(isProtectedHeader(name), true, `${name} must be protected`);
  }
  assert.equal(isProtectedHeader('Reply-To'), false);
  assert.equal(isProtectedHeader('List-Unsubscribe'), false);
});

test('selected profiles reserve their own MIME, Date, and Message-ID headers', () => {
  for (const name of [
    'Content-Type', 'Content-Transfer-Encoding', 'MIME-Version', 'Date', 'Message-ID',
    'Received', 'X-SES-Outgoing'
  ]) {
    assert.equal(isInboxPatternHeaderBlocked(name), true, `${name} must be blocked`);
  }
  assert.equal(isInboxPatternHeaderBlocked('Reply-To'), false);
  assert.equal(isInboxPatternHeaderBlocked('List-Unsubscribe'), false);
});

test('strict renderer resolves every supported placeholder and encoded variant', () => {
  const template = [
    '{{ToEmail}}', '{{ToName}}', '{{FromName}}', '{{FromEmail}}', '{{SubjectLine}}',
    '{{MessageId}}', '{{PlainContent}}', '{{HtmlContent}}', '{{Domain}}', '{{FromDomain}}',
    '{{PlainContent_base64}}', '{{HtmlContent_base64}}',
    '{{PlainContent_qp}}', '{{HtmlContent_qp}}'
  ].join('|');

  const rendered = renderTemplate(template, VALUES, deterministicOptions());
  assert.match(rendered, /recipient@example\.net\|Recipient Name\|Sender Name/);
  assert.match(rendered, new RegExp(Buffer.from(VALUES.PlainContent).toString('base64')));
  assert.match(rendered, /Plain caf=C3=A9 content/);
  assert.match(rendered, /HTML caf=C3=A9 content/);
  assert.doesNotMatch(rendered, /\{\{|\[\[/);
});

test('strict renderer supports every documented generated expression deterministically', () => {
  const rendered = renderTemplate(
    [
      '[[time()]]', '[[num(3)]]', '[[smallchar(3)]]', '[[bigchar(3)]]',
      '[[mixall(3)]]', '[[mixsmallalphanum(3)]]', '[[mixbigalphanum(3)]]',
      '[[hexdigit(3)]]', '[[RFC_Date_UTC]]', '[[RFC_Date_IST()]]',
      '[[RFC_Date_EST]]', '[[RFC_Date_EDT()]]'
    ].join('|'),
    {},
    deterministicOptions()
  );

  assert.equal(rendered,
    '1704164645|000|aaa|AAA|aaa|aaa|AAA|000|' +
    'Tue, 02 Jan 2024 03:04:05 +0000|' +
    'Tue, 02 Jan 2024 08:34:05 +0530|' +
    'Mon, 01 Jan 2024 22:04:05 -0500|' +
    'Mon, 01 Jan 2024 23:04:05 -0400');
});

test('strict renderer rejects malformed, unknown, out-of-range, and unresolved syntax', () => {
  const cases = [
    ['[[num(x)]]', /integer length/],
    ['[[num(0)]]', /between 1/],
    [`[[num(${MAX_GENERATED_LENGTH + 1})]]`, /between 1/],
    ['[[unknown(3)]]', /Unknown pattern expression/],
    ['[[num(3)', /Malformed or unresolved/],
    ['{{Unknown}}', /Unknown pattern placeholder/],
    ['{{ToEmail}', /Malformed or unresolved/],
    ['{{ToEmail}}', /Missing value/]
  ];

  for (const [template, expected] of cases) {
    assert.throws(
      () => renderTemplate(template, {}, deterministicOptions()),
      (error) => error instanceof InboxPatternRenderError && expected.test(error.message),
      template
    );
  }
  assert.throws(() => renderInboxPattern('not-a-pattern', VALUES), /Unknown inbox pattern/);
});

test('all curated profiles compile to parseable safe multipart MIME', async () => {
  const transporter = nodemailer.createTransport({
    streamTransport: true,
    buffer: true,
    newline: 'unix'
  });

  for (const profile of INBOX_PATTERNS) {
    const options = renderInboxPattern(profile.id, VALUES, deterministicOptions());
    const info = await transporter.sendMail(options);
    const raw = info.message.toString('utf8');
    const parsed = await simpleParser(info.message);

    assert.equal(parsed.subject, VALUES.SubjectLine);
    assert.equal(parsed.text.trim(), VALUES.PlainContent);
    assert.match(parsed.html, /HTML café content/);
    assert.equal(parsed.messageId, options.messageId);
    assert.ok(parsed.date instanceof Date && !Number.isNaN(parsed.date.getTime()));
    assert.match(raw, /Content-Type: multipart\/alternative;/i);
    assert.match(raw, /charset=utf-8/i);
    assert.match(raw, new RegExp(`boundary="${options.boundaryPrefix}-${options.baseBoundary}-Part_1"`));

    for (const name of headerNames(raw)) {
      assert.equal(isProtectedHeader(name), false, `${profile.id} emitted protected header ${name}`);
    }

    const expectedEncodings = [
      profile.mailOptions.text.contentTransferEncoding,
      profile.mailOptions.html.contentTransferEncoding
    ];
    for (const encoding of expectedEncodings) {
      assert.match(raw, new RegExp(`Content-Transfer-Encoding: ${encoding}`, 'i'));
    }
  }
});

test('rendered Message-ID and boundary values are validated', () => {
  assert.throws(
    () => renderTemplate('[[mixall(2)]]', {}, { now: FIXED_NOW, random: () => 1 }),
    /random source/
  );

  assert.throws(
    () => renderInboxPattern('pattern-1', { ...VALUES, Domain: 'bad domain' }, deterministicOptions()),
    /Message-ID is invalid/
  );
});
