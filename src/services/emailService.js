const nodemailer = require('nodemailer');

const restrictedPhrases = [
  'suspicious transaction report',
  'suspicious transaction',
  'suspicious activity',
  'str',
  'money laundering',
  'terrorist financing',
  'sanctions match',
  'sanction match',
  'watchlist match',
  'pep match',
  'adverse media match',
  'risk score',
  'critical risk',
  'high risk customer',
  'aml investigation',
  'investigation case',
  'police investigation',
  'law enforcement',
  'reported to authorities',
];

let cachedTransporter = null;
let cachedConfigKey = null;
let transporterVerified = false;

function normalizeForRestrictedPhraseCheck(value) {
  const normalized = String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized.replace(/\b(?:[a-z]\s+){2,}[a-z]\b/g, (match) => match.replace(/\s+/g, ''));
}

function findRestrictedPhrase(...values) {
  const normalized = normalizeForRestrictedPhraseCheck(values.filter(Boolean).join(' '));
  if (!normalized) return null;
  return restrictedPhrases.find((phrase) => {
    const candidate = normalizeForRestrictedPhraseCheck(phrase);
    return (` ${normalized} `).includes(` ${candidate} `);
  }) || null;
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
}

function parseMailbox(value) {
  const mailbox = String(value || '').trim();
  if (isValidEmail(mailbox)) return { address: mailbox, name: null };
  const match = mailbox.match(/^\s*"?([^"<>\r\n]+?)"?\s*<([^<>\s@]+@[^<>\s@]+\.[^<>\s@]+)>\s*$/);
  if (!match || !isValidEmail(match[2])) return null;
  return { address: match[2], name: match[1].trim() || null };
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function parseSmtpConfig(env = process.env) {
  const required = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM'];
  const missing = required.filter((key) => !String(env[key] || '').trim());
  if (missing.length) {
    const error = new Error(`Missing SMTP configuration: ${missing.join(', ')}`);
    error.code = 'EMISSINGCONFIG';
    throw error;
  }

  const port = Number(env.SMTP_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    const error = new Error('SMTP_PORT must be a whole number from 1 to 65535');
    error.code = 'EINVALIDCONFIG';
    throw error;
  }

  const secureValue = String(env.SMTP_SECURE).trim().toLowerCase();
  if (!['true', 'false'].includes(secureValue)) {
    const error = new Error('SMTP_SECURE must be true or false');
    error.code = 'EINVALIDCONFIG';
    throw error;
  }
  const secure = secureValue === 'true';
  if (port === 465 && !secure) {
    const error = new Error('SMTP_SECURE must be true when SMTP_PORT is 465');
    error.code = 'EINVALIDCONFIG';
    throw error;
  }
  const fromMailbox = parseMailbox(env.SMTP_FROM);
  if (!fromMailbox) {
    const error = new Error('SMTP_FROM must be a valid email address or mailbox');
    error.code = 'EINVALIDCONFIG';
    throw error;
  }

  return {
    host: String(env.SMTP_HOST).trim(),
    port,
    secure,
    user: String(env.SMTP_USER).trim(),
    pass: String(env.SMTP_PASS),
    from: fromMailbox.address,
    fromName: String(env.SMTP_FROM_NAME || fromMailbox.name || 'UNIWEB Transaction Monitoring Team').trim(),
  };
}

function formatAmount(currency, amount) {
  return `${currency || 'SGD'} ${Number(amount || 0).toLocaleString('en-SG', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function buildRfiEmail({
  recipientName,
  transactionId,
  transactionDate,
  currency,
  amount,
  informationRequested,
}) {
  const greetingName = String(recipientName || 'Customer').trim() || 'Customer';
  const request = String(informationRequested || '').trim();
  const formattedAmount = formatAmount(currency, amount);
  const text = [
    `Dear ${greetingName},`,
    '',
    'We are reviewing a recent transaction and require some additional information to complete our standard verification process.',
    '',
    `Transaction reference: ${transactionId}`,
    `Transaction date: ${transactionDate}`,
    `Transaction amount: ${formattedAmount}`,
    '',
    'Please provide the following information:',
    '',
    request,
    '',
    'Please reply with the requested information and any relevant supporting documents.',
    '',
    'Thank you for your cooperation.',
    '',
    'Regards,',
    'UNIWEB Transaction Monitoring Team',
  ].join('\n');

  const htmlRequest = escapeHtml(request).replace(/\r?\n/g, '<br>');
  const html = [
    `<p>Dear ${escapeHtml(greetingName)},</p>`,
    '<p>We are reviewing a recent transaction and require some additional information to complete our standard verification process.</p>',
    '<dl>',
    `<dt><strong>Transaction reference</strong></dt><dd>${escapeHtml(transactionId)}</dd>`,
    `<dt><strong>Transaction date</strong></dt><dd>${escapeHtml(transactionDate)}</dd>`,
    `<dt><strong>Transaction amount</strong></dt><dd>${escapeHtml(formattedAmount)}</dd>`,
    '</dl>',
    '<p><strong>Please provide the following information:</strong></p>',
    `<p>${htmlRequest}</p>`,
    '<p>Please reply with the requested information and any relevant supporting documents.</p>',
    '<p>Thank you for your cooperation.</p>',
    '<p>Regards,<br>UNIWEB Transaction Monitoring Team</p>',
  ].join('');

  return { text, html };
}

function smtpConfigKey(config) {
  return JSON.stringify([config.host, config.port, config.secure, config.user, config.from]);
}

function getSmtpTransporter(config, createTransport = nodemailer.createTransport) {
  const key = smtpConfigKey(config);
  if (!cachedTransporter || cachedConfigKey !== key) {
    cachedTransporter = createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: { user: config.user, pass: config.pass },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
    cachedConfigKey = key;
    transporterVerified = false;
  }
  return cachedTransporter;
}

async function verifyTransporter(transporter) {
  if (transporterVerified) return;
  await transporter.verify();
  transporterVerified = true;
}

function acceptedRecipient(info, intendedRecipient) {
  const intended = String(intendedRecipient || '').trim().toLowerCase();
  return (Array.isArray(info?.accepted) ? info.accepted : [])
    .some((value) => String(value || '').trim().toLowerCase() === intended);
}

async function sendRfiEmail(options, dependencies = {}) {
  const config = parseSmtpConfig(dependencies.env || process.env);
  const to = String(options.to || '').trim();
  if (!isValidEmail(to)) {
    const error = new Error('Recipient email is missing or invalid');
    error.code = 'EENVELOPE';
    throw error;
  }

  const subject = String(options.subject || '').trim();
  const { text, html } = buildRfiEmail(options);
  const transporter = getSmtpTransporter(config, dependencies.createTransport || nodemailer.createTransport);
  let info;
  try {
    await verifyTransporter(transporter);
    info = await transporter.sendMail({
      from: `${config.fromName} <${config.from}>`,
      to,
      subject,
      text,
      html,
    });
  } catch (error) {
    transporterVerified = false;
    throw error;
  }

  if (!acceptedRecipient(info, to)) {
    const error = new Error('SMTP provider did not accept the intended recipient');
    error.code = 'EDELIVERYNOTACCEPTED';
    throw error;
  }

  return {
    provider: 'smtp',
    recipient: to,
    messageId: info.messageId || null,
  };
}

function resetTransporterForTests() {
  cachedTransporter = null;
  cachedConfigKey = null;
  transporterVerified = false;
}

module.exports = {
  buildRfiEmail,
  escapeHtml,
  findRestrictedPhrase,
  isValidEmail,
  parseMailbox,
  parseSmtpConfig,
  sendRfiEmail,
  resetTransporterForTests,
};
