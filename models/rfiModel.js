const database = require('../src/database');

async function listCaseEvidence(caseId) {
  const [rows] = await database.query(
    `SELECT evidence_id, evidence_type, description, mailbox_reference, recorded_by, recorded_at
     FROM case_rfi_evidence WHERE case_id = ? ORDER BY recorded_at DESC`,
    [caseId],
  );
  return rows;
}

async function insertCaseEvidence({
  evidenceId, caseId, transactionId, evidenceType, description, mailboxReference, recordedBy,
}) {
  await database.execute(
    `INSERT INTO case_rfi_evidence (evidence_id, case_id, transaction_id, evidence_type, description, mailbox_reference, recorded_by, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
    [evidenceId, caseId, transactionId, evidenceType, description, mailboxReference, recordedBy],
  );
}

// Both run inside rfiWorkflow.js's database.withTransaction block, so they take the transaction
// executor (tx) as their db client - defaulting to the real database outside a transaction.
async function insertFailedRequest(db, {
  rfiId, transactionId, caseId, sentBy, recipientEmail, subject, requestSummary, failureCode, failureMessage,
}) {
  const client = db || database;
  await client.execute(
    `INSERT INTO rfi_requests
      (rfi_id, transaction_id, case_id, sent_by, recipient_email, subject, request_summary,
       status, failure_code, failure_message, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'Failed', ?, ?, NOW(), NOW())`,
    [rfiId, transactionId, caseId, sentBy, recipientEmail, subject, requestSummary, failureCode, failureMessage],
  );
}

async function insertSentRequest(db, {
  rfiId, transactionId, caseId, sentBy, recipientEmail, subject, requestSummary, outboundMessageId,
}) {
  const client = db || database;
  await client.execute(
    `INSERT INTO rfi_requests
      (rfi_id, transaction_id, case_id, sent_by, recipient_email, subject, request_summary,
       status, outbound_message_id, sent_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'Sent', ?, NOW(), NOW(), NOW())`,
    [rfiId, transactionId, caseId, sentBy, recipientEmail, subject, requestSummary, outboundMessageId],
  );
}

async function insertReceipt(db, {
  receiptId, transactionId, caseId, fingerprint, mailboxReference, sender, subject, emailDate,
}) {
  const client = db || database;
  const [result] = await client.execute(
    `INSERT IGNORE INTO rfi_email_receipts
      (receipt_id, transaction_id, case_id, message_fingerprint, mailbox_reference,
       sender, subject, email_date, detected_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
    [receiptId, transactionId, caseId, fingerprint, mailboxReference, sender, subject, emailDate],
  );
  return result;
}

async function markReplied(db, {
  rfiId, replyMessageId, replySender, replySubject,
}) {
  const client = db || database;
  await client.execute(
    `UPDATE rfi_requests
     SET status = 'Replied', reply_message_id = ?, reply_sender = ?, reply_subject = ?,
         replied_at = COALESCE(replied_at, NOW()), updated_at = NOW()
     WHERE rfi_id = ?`,
    [replyMessageId, replySender, replySubject, rfiId],
  );
}

// rfiReplyChecker.js's background sweep - capped at 50 per run to bound one job cycle.
async function findPendingSent(db) {
  const client = db || database;
  const [rows] = await client.query(
    `SELECT rfi_id, transaction_id, case_id, sent_by, recipient_email,
            outbound_message_id, sent_at, status
     FROM rfi_requests
     WHERE status = 'Sent'
     ORDER BY sent_at ASC
     LIMIT 50`,
  );
  return rows;
}

async function findLatestSent(db, transactionId) {
  const client = db || database;
  const [rows] = await client.query(
    `SELECT rfi_id, transaction_id, case_id, sent_by, recipient_email, outbound_message_id, sent_at, status
     FROM rfi_requests
     WHERE transaction_id = ? AND status IN ('Sent', 'Replied')
     ORDER BY sent_at DESC, created_at DESC
     LIMIT 1`,
    [transactionId],
  );
  return rows[0] || null;
}

module.exports = {
  listCaseEvidence,
  insertCaseEvidence,
  insertFailedRequest,
  insertSentRequest,
  insertReceipt,
  markReplied,
  findPendingSent,
  findLatestSent,
};
