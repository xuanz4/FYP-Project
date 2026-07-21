const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { suite, runTest, finish } = require('./runAll');
const app = require('../app');
const emailService = require('../src/services/emailService');

const {
  isValidTransactionId,
  selectRfiDeliveryRecipient,
  validateRfiAccess,
  validateRfiRequestBody,
} = app.locals.rfiWorkflowHelpers;

function context(overrides = {}) {
  return {
    caseId: 'CASE-001',
    currentStatus: 'Under Review',
    assignedRole: null,
    escalationDestination: null,
    strStatus: null,
    ...overrides,
  };
}

function testRoleAccess() {
  assert.strictEqual(validateRfiAccess('Analyst', context()).allowed, true);
  assert.strictEqual(validateRfiAccess('Senior Analyst', context({ assignedRole: 'Senior Analyst' })).allowed, true);
  assert.strictEqual(validateRfiAccess('STRO', context({ assignedRole: 'STRO', strStatus: 'Recommended' })).allowed, true);
  assert.strictEqual(validateRfiAccess('Admin', context()).status, 403);
  assert.strictEqual(validateRfiAccess('STRO', context({ strStatus: 'Recommended' })).status, 403);
  assert.strictEqual(validateRfiAccess('STRO', context({ assignedRole: 'STRO', strStatus: 'Filed' })).status, 409);
  assert.strictEqual(validateRfiAccess('STRO', context({ assignedRole: 'STRO', strStatus: 'Not Required' })).status, 409);
  assert.strictEqual(validateRfiAccess('Analyst', context({ currentStatus: 'Resolved' })).status, 409);
  assert.strictEqual(validateRfiAccess('Analyst', context({ currentStatus: 'Dismissed as False Positive' })).status, 409);
  assert.strictEqual(validateRfiAccess('Analyst', context({ currentStatus: 'STR Filed' })).status, 409);
  assert.strictEqual(validateRfiAccess('Senior Analyst', context()).status, 403);
  assert.strictEqual(validateRfiAccess('Senior Analyst', context({ caseId: null })).status, 409);
}

function testRecipientAndRequestValidation() {
  assert.deepStrictEqual(selectRfiDeliveryRecipient({ savedEmail: '', accountType: 'Organisation' }), {
    email: null, source: 'missing',
  });
  assert.strictEqual(selectRfiDeliveryRecipient({ savedEmail: 'contact@merchant.test', accountType: 'Organisation' }).email, 'contact@merchant.test');
  assert.strictEqual(emailService.isValidEmail('invalid'), false);
  assert.strictEqual(isValidTransactionId('TXN-2026-001'), true);
  assert.strictEqual(isValidTransactionId('../bad'), false);
  assert.match(validateRfiRequestBody({ subject: '', informationRequested: 'Please provide the invoice.' }), /Subject/);
  assert.match(validateRfiRequestBody({ subject: 'Request', informationRequested: 'short' }), /10 characters/);
  assert.match(validateRfiRequestBody({ subject: 'S.T.R. update', informationRequested: 'Please provide supporting records.' }), /internal compliance/);
  assert.match(validateRfiRequestBody({ subject: 'Request', informationRequested: 'Provide suspicious-activity details.' }), /internal compliance/);
  assert.strictEqual(validateRfiRequestBody({
    subject: 'Request for Additional Transaction Information',
    informationRequested: 'Please provide the matching invoice and receipt.',
  }), null);
}

function testSmtpConfiguration() {
  assert.throws(() => emailService.parseSmtpConfig({}), (error) => error.code === 'EMISSINGCONFIG');
  assert.throws(() => emailService.parseSmtpConfig({
    SMTP_HOST: 'smtp.invalid', SMTP_PORT: 'abc', SMTP_SECURE: 'false',
    SMTP_USER: 'user', SMTP_PASS: 'pass', SMTP_FROM: 'sender@merchant.test',
  }), (error) => error.code === 'EINVALIDCONFIG');
  assert.throws(() => emailService.parseSmtpConfig({
    SMTP_HOST: 'smtp.invalid', SMTP_PORT: '465', SMTP_SECURE: 'false',
    SMTP_USER: 'user', SMTP_PASS: 'pass', SMTP_FROM: 'sender@merchant.test',
  }), (error) => error.code === 'EINVALIDCONFIG');
  const config = emailService.parseSmtpConfig({
    SMTP_HOST: 'smtp.invalid', SMTP_PORT: '587', SMTP_SECURE: 'false',
    SMTP_USER: 'user', SMTP_PASS: 'pass', SMTP_FROM: 'sender@merchant.test',
  });
  assert.strictEqual(config.port, 587);
  assert.strictEqual(config.secure, false);
  const mailboxConfig = emailService.parseSmtpConfig({
    SMTP_HOST: 'smtp.invalid', SMTP_PORT: '587', SMTP_SECURE: 'false',
    SMTP_USER: 'user', SMTP_PASS: 'pass', SMTP_FROM: 'UNIWEB Team <sender@merchant.test>',
  });
  assert.strictEqual(mailboxConfig.from, 'sender@merchant.test');
  assert.strictEqual(mailboxConfig.fromName, 'UNIWEB Team');
}

function testNeutralMultipartContent() {
  const message = emailService.buildRfiEmail({
    recipientName: '<Customer>',
    transactionId: 'TXN-001',
    transactionDate: '20/07/2026, 10:00:00',
    currency: 'SGD',
    amount: 123.4,
    informationRequested: 'Please provide <invoice> & receipt.\nThank you.',
  });
  assert.match(message.text, /Request|provide/i);
  assert.match(message.text, /TXN-001/);
  assert.match(message.html, /&lt;Customer&gt;/);
  assert.match(message.html, /&lt;invoice&gt; &amp; receipt/);
  assert.doesNotMatch(message.text, /risk score|law enforcement|investigation case/i);
}

async function testSmtpDeliveryAndFailures() {
  const env = {
    SMTP_HOST: 'smtp.invalid', SMTP_PORT: '587', SMTP_SECURE: 'false',
    SMTP_USER: 'user', SMTP_PASS: 'pass', SMTP_FROM: 'sender@merchant.test',
  };
  const options = {
    to: 'contact@merchant.test',
    recipientName: 'Customer',
    transactionId: 'TXN-001',
    transactionDate: '20/07/2026, 10:00:00',
    currency: 'SGD', amount: 20,
    subject: 'Request for Additional Transaction Information',
    informationRequested: 'Please provide the matching invoice.',
  };

  let verifyCount = 0;
  let sentMessage = null;
  emailService.resetTransporterForTests();
  const delivery = await emailService.sendRfiEmail(options, {
    env,
    createTransport: () => ({
      verify: async () => { verifyCount += 1; },
      sendMail: async (message) => {
        sentMessage = message;
        return { accepted: [options.to], rejected: [], messageId: 'smtp-message-1' };
      },
    }),
  });
  assert.strictEqual(delivery.provider, 'smtp');
  assert.strictEqual(delivery.messageId, 'smtp-message-1');
  assert.strictEqual(verifyCount, 1);
  assert.match(sentMessage.text, /TXN-001/);
  assert.match(sentMessage.html, /TXN-001/);

  emailService.resetTransporterForTests();
  await assert.rejects(emailService.sendRfiEmail(options, {
    env,
    createTransport: () => ({
      verify: async () => {},
      sendMail: async () => ({ accepted: [], rejected: [options.to], messageId: 'rejected' }),
    }),
  }), (error) => error.code === 'EDELIVERYNOTACCEPTED');

  for (const code of ['EAUTH', 'ETIMEDOUT', 'ECONNECTION']) {
    emailService.resetTransporterForTests();
    await assert.rejects(emailService.sendRfiEmail(options, {
      env,
      createTransport: () => ({
        verify: async () => { const error = new Error('safe failure'); error.code = code; throw error; },
        sendMail: async () => { throw new Error('must not send after verification failure'); },
      }),
    }), (error) => error.code === code);
  }
}

function testFrontendIsLocalOnlyAndProtectsDoubleClick() {
  const view = fs.readFileSync(path.join(__dirname, '..', 'views', 'transaction-detail.ejs'), 'utf8');
  const previewHandler = view.slice(view.indexOf("previewButton?.addEventListener"), view.indexOf("form?.addEventListener"));
  assert.doesNotMatch(previewHandler, /fetch\(|sendMail|\/rfi/);
  assert.match(view, /sendButton\.disabled = true/);
  assert.match(view, /sendButton\.disabled = false/);
  assert.match(view, /const canSendRfi = !isRfiTerminal/);
}

async function main() {
  suite('RFI Workflow');
  await runTest('enforces role access for RFI sending', testRoleAccess);
  await runTest('validates RFI recipient and request body', testRecipientAndRequestValidation);
  await runTest('validates SMTP configuration', testSmtpConfiguration);
  await runTest('builds neutral multipart RFI email content', testNeutralMultipartContent);
  await runTest('keeps RFI preview local and protects against double click sends', testFrontendIsLocalOnlyAndProtectsDoubleClick);
  await runTest('handles SMTP delivery success and provider failures', testSmtpDeliveryAndFailures);
  finish();
}

main();
