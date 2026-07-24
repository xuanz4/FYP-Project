const crypto = require('crypto');
const database = require('../database');
const { id } = require('../lib/ids');
const { ensureNotificationSchema, ensureRiskAndContactSchema } = require('../lib/schema');
const { logAdminAudit } = require('../lib/auditLog');
const { fetchLatestRfiResponse } = require('./rfiInboxService');
const { createNotification } = require('./notificationService');
const emailService = require('./emailService');

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
    const [rows] = await db.query('SELECT assigned_to FROM cases WHERE case_id = ? LIMIT 1', [rfi.case_id]);
    if (rows[0]?.assigned_to) recipients.add(rows[0].assigned_to);
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
  const [receiptResult] = await db.execute(
    `INSERT IGNORE INTO rfi_email_receipts
      (receipt_id, transaction_id, case_id, message_fingerprint, mailbox_reference,
       sender, subject, email_date, detected_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
    [
      id('RFI-REPLY'), rfi.transaction_id, rfi.case_id, fingerprint, mailboxReference,
      String(message.from || '').slice(0, 255) || null,
      String(message.subject || '').slice(0, 255) || null,
      String(message.date || '').slice(0, 255) || null,
    ],
  );

  if (receiptResult.affectedRows !== 1) {
    return { matched: true, created: false, fingerprint, mailboxReference };
  }

  await db.execute(
    `UPDATE rfi_requests
     SET status = 'Replied', reply_message_id = ?, reply_sender = ?, reply_subject = ?,
         replied_at = COALESCE(replied_at, NOW()), updated_at = NOW()
     WHERE rfi_id = ?`,
    [
      String(message.messageId || '').slice(0, 255) || null,
      String(message.from || '').slice(0, 255) || null,
      String(message.subject || '').slice(0, 255) || null,
      rfi.rfi_id,
    ],
  );

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
  const [rows] = await db.query(
    `SELECT rfi_id, transaction_id, case_id, sent_by, recipient_email, outbound_message_id, sent_at, status
     FROM rfi_requests
     WHERE transaction_id = ? AND status IN ('Sent', 'Replied')
     ORDER BY sent_at DESC, created_at DESC
     LIMIT 1`,
    [transactionId],
  );
  return rows[0] || null;
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
