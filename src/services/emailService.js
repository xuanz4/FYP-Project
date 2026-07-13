const nodemailer = require('nodemailer');

const restrictedPhrases = [
  'suspicious transaction report',
  'suspicious transaction',
  'STR',
  'money laundering',
  'terrorist financing',
  'sanctions match',
  'sanction match',
  'watchlist match',
  'PEP match',
  'adverse media match',
  'risk score',
  'critical risk',
  'high risk customer',
  'AML investigation',
  'police investigation',
  'law enforcement',
  'reported to authorities',
];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Prototype safeguard only. This keyword check does not replace legal or compliance review.
function findRestrictedPhrase(...values) {
  const text = values.filter(Boolean).join(' ');
  return restrictedPhrases.find((phrase) => {
    const escaped = escapeRegExp(phrase);
    const startsWithWord = /^[a-z0-9]/i.test(phrase) ? '\\b' : '';
    const endsWithWord = /[a-z0-9]$/i.test(phrase) ? '\\b' : '';
    return new RegExp(`${startsWithWord}${escaped}${endsWithWord}`, 'i').test(text);
  }) || null;
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
}

function maskEmail(value) {
  const email = String(value || '').trim();
  const [name, domain] = email.split('@');
  if (!name || !domain) return '';
  return `${name.slice(0, 2)}***@${domain}`;
}

function maskEmailList(values) {
  return (values || []).map((value) => maskEmail(value)).filter(Boolean);
}

function getEmailRuntimeConfig() {
  const testMode = process.env.EMAIL_TEST_MODE === 'true';
  const provider = String(process.env.EMAIL_PROVIDER || 'smtp').toLowerCase();
  return {
    provider,
    etherealMode: provider === 'ethereal',
    testMode,
  };
}

function validateSmtpConfig() {
  if (String(process.env.EMAIL_PROVIDER || 'smtp').toLowerCase() === 'ethereal') return;

  const required = ['EMAIL_HOST', 'EMAIL_PORT', 'EMAIL_SECURE', 'EMAIL_USER', 'EMAIL_PASSWORD', 'EMAIL_FROM'];
  const missing = required.filter((key) => !String(process.env[key] || '').trim());
  if (missing.length) {
    const error = new Error(`Missing email configuration: ${missing.join(', ')}`);
    error.code = 'EMISSINGCONFIG';
    throw error;
  }
}

function formatAmount(currency, amount) {
  return `${currency || 'SGD'} ${Number(amount || 0).toLocaleString('en-SG', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function buildRfiEmail({
  recipientName,
  companyName,
  transactionId,
  transactionDate,
  currency,
  amount,
  informationRequested,
}) {
  return [
    `Dear ${recipientName},`,
    '',
    'We require additional information to complete our routine review of a recent transaction.',
    '',
    'Please provide the following information or supporting documents:',
    '',
    String(informationRequested || '').trim(),
    '',
    `Transaction reference: ${transactionId}`,
    `Transaction date: ${transactionDate}`,
    `Transaction amount: ${formatAmount(currency, amount)}`,
    '',
    'Please reply to this email with the requested information.',
    '',
    'Thank you.',
    '',
    'Customer Review Team',
    companyName,
  ].filter((line) => line !== null).join('\n');
}

function getTransporter() {
  return nodemailer.createTransport({
    host: process.env.EMAIL_HOST,
    port: Number(process.env.EMAIL_PORT || 587),
    secure: process.env.EMAIL_SECURE === 'true',
    auth: process.env.EMAIL_USER || process.env.EMAIL_PASSWORD
      ? {
          user: process.env.EMAIL_USER,
          pass: process.env.EMAIL_PASSWORD,
        }
      : undefined,
  });
}

async function getEtherealTransporter() {
  const account = await nodemailer.createTestAccount();
  return nodemailer.createTransport({
    host: account.smtp.host,
    port: account.smtp.port,
    secure: account.smtp.secure,
    auth: {
      user: account.user,
      pass: account.pass,
    },
  });
}

async function sendRfiEmail(options) {
  validateSmtpConfig();
  const provider = String(process.env.EMAIL_PROVIDER || 'smtp').toLowerCase();
  const etherealMode = provider === 'ethereal';
  const testMode = process.env.EMAIL_TEST_MODE === 'true';
  const to = options.to;
  if (!isValidEmail(to)) {
    const error = new Error('Customer email is missing or invalid');
    error.code = 'EENVELOPE';
    throw error;
  }

  const subject = `${testMode || etherealMode ? '[TEST] ' : ''}${options.subject}`;
  const text = buildRfiEmail(options);
  const fromName = process.env.EMAIL_FROM_NAME || 'Customer Review Team';
  const fromAddress = etherealMode ? 'no-reply@ethereal.email' : process.env.EMAIL_FROM;
  const from = fromAddress ? `${fromName} <${fromAddress}>` : fromName;

  const transporter = etherealMode ? await getEtherealTransporter() : getTransporter();
  let info;
  try {
    await transporter.verify();
    console.log('SMTP connection verified.');
    info = await transporter.sendMail({
      from,
      to,
      subject,
      text,
    });
  } catch (error) {
    console.error('SMTP delivery failed', {
      code: error.code || null,
      command: error.command || null,
      message: error.message,
    });
    throw error;
  }

  return {
    info,
    testMode: testMode || etherealMode,
    etherealMode,
    previewUrl: etherealMode ? nodemailer.getTestMessageUrl(info) : null,
    subject,
    body: text,
    delivery: {
      accepted: maskEmailList(info.accepted),
      rejected: maskEmailList(info.rejected),
      pending: maskEmailList(info.pending),
      response: info.response || null,
      messageId: info.messageId || null,
    },
  };
}

module.exports = {
  buildRfiEmail,
  findRestrictedPhrase,
  getEmailRuntimeConfig,
  isValidEmail,
  maskEmail,
  maskEmailList,
  sendRfiEmail,
};
