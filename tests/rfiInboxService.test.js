const assert = require('assert');
const { suite, runTest, finish } = require('./runAll');
const { parseEmailMessage, parseInboxConfig } = require('../src/services/rfiInboxService');

function testParseInboxConfigUsesGmailDefaults() {
  const config = parseInboxConfig({
    SMTP_USER: 'testnetc300@gmail.com',
    SMTP_PASS: 'app-password',
    SMTP_FROM: 'UNIWEB <testnetc300@gmail.com>',
  });

  assert.strictEqual(config.host, 'imap.gmail.com');
  assert.strictEqual(config.port, 993);
  assert.strictEqual(config.user, 'testnetc300@gmail.com');
  assert.strictEqual(config.mailbox, 'INBOX');
  assert.strictEqual(config.account, 'testnetc300@gmail.com');
}

function testParseInboxConfigUsesExplicitImapSettings() {
  const config = parseInboxConfig({
    IMAP_HOST: 'imap.example.test',
    IMAP_PORT: '1993',
    IMAP_USER: 'imap-user',
    IMAP_PASS: 'imap-pass',
    IMAP_MAILBOX: 'RFI',
    SMTP_FROM: 'Review Team <review@example.test>',
  });

  assert.strictEqual(config.host, 'imap.example.test');
  assert.strictEqual(config.port, 1993);
  assert.strictEqual(config.user, 'imap-user');
  assert.strictEqual(config.mailbox, 'RFI');
  assert.strictEqual(config.account, 'review@example.test');
}

function testParseInboxConfigRejectsMissingOrInvalidSettings() {
  assert.throws(() => parseInboxConfig({}), (error) => error.code === 'EMISSINGIMAPCONFIG');
  assert.throws(() => parseInboxConfig({
    IMAP_HOST: 'imap.example.test',
    IMAP_PORT: 'bad',
    IMAP_USER: 'user',
    IMAP_PASS: 'pass',
  }), (error) => error.code === 'EINVALIDIMAPCONFIG');
}

function testParseEmailMessageExtractsPlainText() {
  const message = parseEmailMessage([
    'From: Merchant Contact <merchant@example.test>',
    'Subject: Re: Request for Additional Transaction Information',
    'Date: Wed, 22 Jul 2026 10:00:00 +0800',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Here is the requested invoice information for TXN-001.',
  ].join('\r\n'));

  assert.strictEqual(message.from, 'Merchant Contact <merchant@example.test>');
  assert.strictEqual(message.subject, 'Re: Request for Additional Transaction Information');
  assert.match(message.text, /requested invoice information/);
}

function testParseEmailMessageDecodesBase64SubjectAndBody() {
  const message = parseEmailMessage([
    'From: merchant@example.test',
    'Subject: =?UTF-8?B?UkZJIHJlc3BvbnNl?=',
    'Content-Transfer-Encoding: base64',
    'Content-Type: text/plain; charset=utf-8',
    '',
    Buffer.from('Invoice and receipt attached.').toString('base64'),
  ].join('\r\n'));

  assert.strictEqual(message.subject, 'RFI response');
  assert.strictEqual(message.text, 'Invoice and receipt attached.');
}

function testParseEmailMessageDecodesQuotedPrintableBody() {
  const message = parseEmailMessage([
    'From: merchant@example.test',
    'Subject: =?UTF-8?Q?RFI_response?=',
    'Content-Transfer-Encoding: quoted-printable',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Invoice attached for transaction=0AThank you.',
  ].join('\r\n'));

  assert.strictEqual(message.subject, 'RFI response');
  assert.match(message.text, /Invoice attached/);
  assert.match(message.text, /Thank you/);
}

function testParseEmailMessageExtractsMultipartHtmlFallback() {
  const message = parseEmailMessage([
    'From: merchant@example.test',
    'Subject: RFI HTML',
    'Content-Type: multipart/alternative; boundary="abc123"',
    '',
    '--abc123',
    'Content-Type: text/html; charset=utf-8',
    '',
    '<p>Invoice<br>Receipt uploaded</p>',
    '--abc123--',
  ].join('\r\n'));

  assert.match(message.text, /Invoice/);
  assert.match(message.text, /Receipt uploaded/);
}

async function main() {
  suite('RFI Inbox Service');
  await runTest('uses Gmail IMAP defaults from SMTP mailbox credentials', testParseInboxConfigUsesGmailDefaults);
  await runTest('uses explicit IMAP inbox settings', testParseInboxConfigUsesExplicitImapSettings);
  await runTest('rejects missing or invalid IMAP settings', testParseInboxConfigRejectsMissingOrInvalidSettings);
  await runTest('extracts plain text response email details', testParseEmailMessageExtractsPlainText);
  await runTest('decodes base64 email subject and body', testParseEmailMessageDecodesBase64SubjectAndBody);
  await runTest('decodes quoted-printable response email content', testParseEmailMessageDecodesQuotedPrintableBody);
  await runTest('extracts text from multipart HTML email fallback', testParseEmailMessageExtractsMultipartHtmlFallback);
  finish();
}

main();
