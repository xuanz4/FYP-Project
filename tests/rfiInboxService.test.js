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

async function main() {
  suite('RFI Inbox Service');
  await runTest('uses Gmail IMAP defaults from SMTP mailbox credentials', testParseInboxConfigUsesGmailDefaults);
  await runTest('extracts plain text response email details', testParseEmailMessageExtractsPlainText);
  await runTest('decodes quoted-printable response email content', testParseEmailMessageDecodesQuotedPrintableBody);
  finish();
}

main();
