'use strict';

const assert = require('node:assert/strict');
const net = require('node:net');
const test = require('node:test');
const nodemailer = require('nodemailer');
const { simpleParser } = require('mailparser');
const {
  configureContentTransferEncodingMessage,
  createMimePart,
  getContentTransferEncodingCapability
} = require('../utils/contentTransferEncoding');

const ENCODING_CASES = [
  { encoding: '7bit', text: 'Plain ASCII', html: '<p>HTML ASCII</p>' },
  { encoding: '8bit', text: 'Plain caf\u00e9', html: '<p>HTML caf\u00e9</p>' },
  { encoding: 'binary', text: 'Plain binary-label body', html: '<p>HTML binary-label body</p>' },
  { encoding: 'base64', text: 'Plain base64 \u2713', html: '<p>HTML base64 \u2713</p>' },
  {
    encoding: 'quoted-printable',
    text: 'Plain quoted-printable \u00e9',
    html: '<p>HTML quoted-printable \u00e9</p>'
  }
];

function createStreamTransport(onConfigured) {
  const transport = nodemailer.createTransport({
    streamTransport: true,
    buffer: true,
    newline: 'windows'
  });

  transport.use('stream', (mail, callback) => {
    try {
      configureContentTransferEncodingMessage(mail);
      if (onConfigured) onConfigured(mail);
      callback();
    } catch (error) {
      callback(error);
    }
  });

  return transport;
}

function createMailOptions(testCase, htmlMode) {
  const options = {
    from: 'Sender <sender@example.test>',
    to: 'recipient@example.test',
    subject: `CTE ${testCase.encoding}`,
    date: new Date('2026-01-01T00:00:00.000Z'),
    messageId: `<cte-${testCase.encoding}@example.test>`,
    text: createMimePart(testCase.text, 'text/plain; charset=utf-8', testCase.encoding)
  };

  if (htmlMode) {
    options.html = createMimePart(
      testCase.html,
      'text/html; charset=utf-8',
      testCase.encoding
    );
  }

  return options;
}

function assertTopLevelHeaders(raw) {
  assert.match(raw, /^From:/mi);
  assert.match(raw, /^To:/mi);
  assert.match(raw, /^Subject:/mi);
  assert.match(raw, /^Date:/mi);
  assert.match(raw, /^MIME-Version: 1\.0$/mi);
  assert.match(raw, /^Message-ID: <cte-[^>]+>$/mi);
}

test('all five CTEs produce valid plain-text MIME and preserve their leaf header/body', async () => {
  const transport = createStreamTransport();

  for (const testCase of ENCODING_CASES) {
    const info = await transport.sendMail(createMailOptions(testCase, false));
    const raw = info.message.toString('utf8');
    const parsed = await simpleParser(info.message);
    const cteHeaders = raw.match(/^Content-Transfer-Encoding: .+$/gmi) || [];

    assertTopLevelHeaders(raw);
    assert.match(raw, /^Content-Type: multipart\/mixed;/mi);
    assert.equal(cteHeaders.length, 1);
    assert.match(cteHeaders[0], new RegExp(`: ${testCase.encoding}$`, 'i'));
    assert.equal(parsed.text.trim(), testCase.text);
    assert.equal(Object.hasOwn(info.envelope, 'use8BitMime'), testCase.encoding === '8bit');
    assert.equal(info.envelope.use8BitMime === true, testCase.encoding === '8bit');
    assert.deepEqual(info.envelope.to, ['recipient@example.test']);
  }
});

test('all five CTEs produce valid HTML alternatives with encoded text and HTML leaves', async () => {
  const transport = createStreamTransport();

  for (const testCase of ENCODING_CASES) {
    const info = await transport.sendMail(createMailOptions(testCase, true));
    const raw = info.message.toString('utf8');
    const parsed = await simpleParser(info.message);
    const cteHeaders = raw.match(/^Content-Transfer-Encoding: .+$/gmi) || [];

    assertTopLevelHeaders(raw);
    assert.match(raw, /^Content-Type: multipart\/alternative;/mi);
    assert.equal(cteHeaders.length, 2);
    assert.ok(cteHeaders.every((header) => header.toLowerCase().endsWith(`: ${testCase.encoding}`)));
    assert.equal(parsed.text.trim(), testCase.text);
    assert.match(parsed.html, new RegExp(testCase.html.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(Object.hasOwn(info.envelope, 'use8BitMime'), testCase.encoding === '8bit');
    assert.equal(info.envelope.use8BitMime === true, testCase.encoding === '8bit');
  }
});

test('8bit envelope preserves recipients and additional envelope fields', async () => {
  let configuredEnvelope;
  const transport = createStreamTransport((mail) => {
    configuredEnvelope = mail.message.getEnvelope();
  });
  await transport.sendMail({
    ...createMailOptions(ENCODING_CASES[1], false),
    envelope: {
      from: 'sender@example.test',
      to: ['recipient@example.test'],
      cc: ['copy@example.test'],
      bcc: ['blind-copy@example.test'],
      customEnvelopeField: 'preserved'
    }
  });

  assert.equal(configuredEnvelope.from, 'sender@example.test');
  assert.deepEqual(configuredEnvelope.to, [
    'recipient@example.test',
    'copy@example.test',
    'blind-copy@example.test'
  ]);
  assert.equal(configuredEnvelope.customEnvelopeField, 'preserved');
  assert.equal(configuredEnvelope.use8BitMime, true);
});

test('8bit SMTP transaction includes BODY=8BITMIME before any message data', async () => {
  const commands = [];
  const server = net.createServer((socket) => {
    let buffer = '';
    socket.write('220 local-test ESMTP\r\n');

    socket.on('data', (chunk) => {
      buffer += chunk.toString('ascii');
      let lineEnd = buffer.indexOf('\r\n');
      while (lineEnd >= 0) {
        const command = buffer.slice(0, lineEnd);
        buffer = buffer.slice(lineEnd + 2);
        commands.push(command);

        if (/^EHLO /i.test(command)) {
          socket.write('250-local-test\r\n250-8BITMIME\r\n250 PIPELINING\r\n');
        } else if (/^MAIL FROM:/i.test(command)) {
          socket.write('550 5.7.1 Test stops before recipient or data\r\n');
        } else if (/^QUIT/i.test(command)) {
          socket.end('221 2.0.0 Bye\r\n');
        } else {
          socket.write('250 2.0.0 OK\r\n');
        }

        lineEnd = buffer.indexOf('\r\n');
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  const transport = nodemailer.createTransport({
    host: '127.0.0.1',
    port: address.port,
    secure: false,
    ignoreTLS: true,
    pool: true,
    maxConnections: 1,
    maxMessages: 1,
    connectionTimeout: 3000,
    greetingTimeout: 3000,
    socketTimeout: 3000
  });
  transport.use('stream', (mail, callback) => {
    try {
      configureContentTransferEncodingMessage(mail);
      callback();
    } catch (error) {
      callback(error);
    }
  });

  try {
    await assert.rejects(transport.sendMail(createMailOptions(ENCODING_CASES[1], false)));
    const mailFrom = commands.find((command) => /^MAIL FROM:/i.test(command));
    assert.ok(mailFrom, 'SMTP MAIL FROM command was observed');
    assert.match(mailFrom, /\bBODY=8BITMIME\b/i);
    assert.equal(commands.some((command) => /^DATA$/i.test(command)), false);
    assert.equal(commands.some((command) => /^AUTH\b/i.test(command)), false);
  } finally {
    transport.close();
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});

test('binary CTE remains a MIME label but true binary SMTP transport is unavailable', () => {
  const capability = getContentTransferEncodingCapability('binary');
  const binaryPart = createMimePart('binary-label body', 'text/plain; charset=utf-8', 'binary');

  assert.equal(capability.mimeHeaderSupported, true);
  assert.equal(capability.trueBinaryTransportSupported, false);
  assert.deepEqual(capability.requiredExtensions, ['BINARYMIME', 'CHUNKING']);
  assert.match(capability.reason, /does not implement BINARYMIME\/CHUNKING/);
  assert.match(binaryPart.raw, /^Content-Type: text\/plain; charset=utf-8\r\nContent-Transfer-Encoding: binary\r\n\r\nbinary-label body$/);
});

test('selected CTE does not alter attachment encoding', async () => {
  const transport = createStreamTransport();
  const info = await transport.sendMail({
    ...createMailOptions(ENCODING_CASES[1], false),
    attachments: [{ filename: 'attachment.txt', content: 'attachment body' }]
  });
  const raw = info.message.toString('utf8');

  assertTopLevelHeaders(raw);
  assert.match(raw, /Content-Transfer-Encoding: 8bit/i);
  assert.match(raw, /Content-Transfer-Encoding: base64/i);
});
