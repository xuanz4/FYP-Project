const crypto = require('crypto');
const database = require('../database');
const { id } = require('../lib/ids');
const { ensureNotificationSchema, ensureRiskAndContactSchema } = require('../lib/schema');
const { logAdminAudit } = require('../lib/auditLog');
const { fetchLatestRfiResponse } = require('./rfiInboxService');
const { createNotification } = require('./notificationService');
const emailService = require('./emailService');
const caseModel = require('../../models/caseModel');
const rfiModel = require('../../models/rfiModel');

function normalizeMessageId(value) {
  return String(value || '').trim().replace(/^<|>$/g, '').toLowerCase();
}

function senderAddress(value) {
  return emailService.parseMailbox(value)?.address?.toLowerCase() || '';
}

function replyFingerprint(message) {
  const anchor = message.messageId
    || [message.from, message.subject, message.date, message.text].join('\n');
  return crypto.createHash('sha256').update(anchor).digest('hex');
}

function isMatchingRfiReply(rfi, mailboxResult) {
  const message = mailboxResult?.message;
  if (!mailboxResult?.found || !message) return false;

  const sender = senderAddress(message.from);
  const expectedSender = String(rfi.recipient_email || '').trim().toLowerCase();
  const mailboxAddress = String(mailboxResult.account || '').trim().toLowerCase();
  if (!sender || sender === mailboxAddress || sender !== expectedSender) return false;

  const outboundId = normalizeMessageId(rfi.outbound_message_id);
  const replyHeaders = `${message.inReplyTo || ''} ${message.references || ''}`.toLowerCase();
  const headerMatches = outboundId && replyHeaders.includes(outboundId);
  const referencesTransaction = [message.subject, message.text]
    .some((value) => String(value || '').includes(rfi.transaction_id));

  return Boolean(headerMatches || referencesTransaction);
}

async function recipientsForReply(rfi, db = database) {
  const recipients = new Set([rfi.sent_by].filter(Boolean));
  if (rfi.case_id) {
    const assignedTo = await caseModel.findAssignedTo(db, rfi.case_id);
    if (assignedTo) recipients.add(assignedTo);
  }
  return [...recipients];
}

async function recordDetectedReply(rfi, mailboxResult, { db = database } = {}) {
  if (!isMatchingRfiReply(rfi, mailboxResult)) return { matched: false, created: false };

  await ensureRiskAndContactSchema();
  await ensureNotificationSchema();
  const message = mailboxResult.message;
  const fingerprint = replyFingerprint(message);
  const mailboxReference = message.messageId
    ? `Message-ID ${message.messageId}`
    : `SHA-256 ${fingerprint}`;
  const receiptResult = await rfiModel.insertReceipt(db, {
    receiptId: id('RFI-REPLY'),
    transactionId: rfi.transaction_id,
    caseId: rfi.case_id,
    fingerprint,
    mailboxReference,
    sender: String(message.from || '').slice(0, 255) || null,
    subject: String(message.subject || '').slice(0, 255) || null,
    emailDate: String(message.date || '').slice(0, 255) || null,
  });

  if (receiptResult.affectedRows !== 1) {
    return { matched: true, created: false, fingerprint, mailboxReference };
  }

  await rfiModel.markReplied(db, {
    rfiId: rfi.rfi_id,
    replyMessageId: String(message.messageId || '').slice(0, 255) || null,
    replySender: String(message.from || '').slice(0, 255) || null,
    replySubject: String(message.subject || '').slice(0, 255) || null,
  });

  await logAdminAudit({
    action: 'RFI_REPLY_RECEIVED',
    userId: null,
    transactionId: rfi.transaction_id,
    entityType: 'RFI',
    entityId: rfi.rfi_id,
    notes: `Merchant reply received. ${mailboxReference}.`,
  }, db);

  const recipients = await recipientsForReply(rfi, db);
  for (const userId of recipients) {
    // Deliberately sequential: duplicate protection is enforced by the unique notification key.
    // eslint-disable-next-line no-await-in-loop
    await createNotification({
      userId,
      caseId: rfi.case_id,
      transactionId: rfi.transaction_id,
      rfiId: rfi.rfi_id,
      replyFingerprint: fingerprint,
      type: 'RFI_REPLIED',
      title: 'Merchant replied to RFI',
      message: `A merchant reply was received for transaction ${rfi.transaction_id}. Click to review the response.`,
      targetUrl: `/transactions/${encodeURIComponent(rfi.transaction_id)}#merchant-rfi-response`,
    }, db);
  }

  return { matched: true, created: true, fingerprint, mailboxReference };
}

async function checkRfiForReply(rfi, {
  db = database,
  fetchResponse = fetchLatestRfiResponse,
} = {}) {
  const mailboxResult = await fetchResponse({ transactionId: rfi.transaction_id });
  const detection = await recordDetectedReply(rfi, mailboxResult, { db });
  return { mailboxResult, detection };
}

async function findLatestSentRfi(transactionId, db = database) {
  await ensureNotificationSchema();
  return rfiModel.findLatestSent(db, transactionId);
}

async function checkLatestTransactionReply(transactionId, dependencies = {}) {
  const rfi = await findLatestSentRfi(transactionId, dependencies.db || database);
  const mailboxResult = await (dependencies.fetchResponse || fetchLatestRfiResponse)({ transactionId });
  if (!rfi) return { mailboxResult, detection: { matched: false, created: false } };
  const detection = await recordDetectedReply(rfi, mailboxResult, { db: dependencies.db || database });
  return { mailboxResult, detection };
}

module.exports = {
  normalizeMessageId,
  senderAddress,
  replyFingerprint,
  isMatchingRfiReply,
  recordDetectedReply,
  checkRfiForReply,
  checkLatestTransactionReply,
  findLatestSentRfi,
};
