const database = require('../database');
const emailService = require('../services/emailService');
const { id } = require('./ids');
const { ensureStrWorkflowSchema, ensureRiskAndContactSchema, ensureNotificationSchema } = require('./schema');
const { createNotification } = require('../services/notificationService');
const { hasMeaningfulAnalystNotes } = require('./strDraft');
const { roleCanPerform, forbidJson } = require('../middleware/auth');

function selectRfiDeliveryRecipient({ savedEmail, accountType }) {
  const trimmedEmail = String(savedEmail || '').trim();
  if (trimmedEmail) {
    return {
      email: trimmedEmail,
      source: accountType === 'Organisation' ? 'saved-organisation-contact' : 'saved-individual',
    };
  }
  return {
    email: null,
    source: 'missing',
  };
}

function isValidTransactionId(value) {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(String(value || '').trim());
}

function validateRfiAccess(role, context) {
  if (!['Analyst', 'Senior Analyst', 'STRO'].includes(role)) {
    return { allowed: false, status: 403, message: 'You do not have permission to perform this action.' };
  }
  if (!context) return { allowed: false, status: 404, message: 'Transaction not found' };
  if (['Resolved', 'Dismissed as False Positive', 'STR Filed'].includes(context.currentStatus)) {
    return { allowed: false, status: 409, message: 'An RFI cannot be sent for a terminal assessment.' };
  }
  if (['Filed', 'Not Required'].includes(context.strStatus)) {
    return { allowed: false, status: 409, message: `An RFI cannot be sent when the STR status is ${context.strStatus}.` };
  }
  if (role === 'Analyst') {
    const routedAway = ['Senior Analyst', 'STRO'].includes(context.assignedRole)
      || ['Senior Analyst', 'STRO'].includes(context.escalationDestination);
    if (routedAway) {
      return { allowed: false, status: 403, message: 'This case has been escalated and can no longer be actioned by an Analyst.' };
    }
  }
  if (role === 'Senior Analyst') {
    const routedToSenior = context.assignedRole === 'Senior Analyst'
      || context.escalationDestination === 'Senior Analyst'
      || context.currentStatus === 'Pending Senior Review';
    if (!context.caseId) {
      return { allowed: false, status: 409, message: 'A related investigation case is required for Senior Analyst RFI.' };
    }
    if (!routedToSenior) {
      return { allowed: false, status: 403, message: 'This case is not routed for Senior Analyst review.' };
    }
  }
  if (role === 'STRO') {
    const routedToStro = context.assignedRole === 'STRO' || context.escalationDestination === 'STRO';
    if (!context.caseId || !routedToStro || context.strStatus !== 'Recommended') {
      return {
        allowed: false,
        status: 403,
        message: 'STRO may request information only for a STRO-routed case with STR status Recommended.',
      };
    }
  }
  return { allowed: true };
}

function validateRfiRequestBody(body) {
  const allowedFields = ['subject', 'informationRequested'];
  const unsupportedFields = Object.keys(body || {}).filter((field) => !allowedFields.includes(field));
  if (unsupportedFields.length) {
    return `Unsupported field submitted: ${unsupportedFields[0]}`;
  }

  const subject = String(body?.subject || '').trim();
  const informationRequested = String(body?.informationRequested || '').trim();
  if (!subject) return 'Subject is required';
  if (!hasMeaningfulAnalystNotes(informationRequested)) {
    return 'Please provide a meaningful information request of at least 10 characters.';
  }

  const restrictedPhrase = emailService.findRestrictedPhrase(subject, informationRequested);
  if (restrictedPhrase) {
    return 'This message may disclose internal compliance information. Please use neutral verification wording.';
  }

  return null;
}

function getSafeEmailError(error) {
  const code = error.code || 'EMAIL_SEND_FAILED';
  if (code === 'EMISSINGCONFIG') {
    return { message: 'SMTP email delivery is not fully configured. Contact an administrator.', code };
  }
  if (code === 'EINVALIDCONFIG') {
    return { message: 'SMTP email delivery configuration is invalid. Contact an administrator.', code };
  }
  if (code === 'EAUTH') {
    return { message: 'SMTP authentication failed. Contact an administrator.', code };
  }
  if (code === 'ECONNECTION' || code === 'ETIMEDOUT' || code === 'ESOCKET') {
    return { message: 'Unable to connect to the SMTP server before the request timed out.', code };
  }
  if (code === 'EENVELOPE') {
    return { message: 'Invalid sender or recipient email.', code };
  }
  if (code === 'EDELIVERYNOTACCEPTED') {
    return { message: 'The email provider did not accept the RFI recipient.', code };
  }
  return { message: 'The RFI email could not be sent.', code };
}

// Contact info is always queried live against merchant_contacts (never cached, never
// hard-coded) so an Admin's edit in Merchant Management takes effect on the very next RFI with
// no other code change.
async function findDatabaseRfiContext(transactionId) {
  if (!database.isEnabled()) return null;
  await ensureRiskAndContactSchema();

  const [rows] = await database.query(
    `SELECT t.transaction_id, t.unique_transaction_reference, t.amount, t.created_at, t.action_status,
            m.merchant_name, m.merchant_mid,
            mc.contact_name, mc.rfi_email,
            c.case_id, c.status AS case_status,
            c.assigned_role, c.escalation_destination, sr.str_status
     FROM transactions t
     LEFT JOIN merchants m ON t.merchant_id = m.merchant_id
     LEFT JOIN merchant_contacts mc ON mc.merchant_id = t.merchant_id AND mc.status = 'Active'
     LEFT JOIN cases c ON c.transaction_id = t.transaction_id
     LEFT JOIN str_reports sr ON sr.case_id = c.case_id
     WHERE t.transaction_id = ?
     ORDER BY c.created_at DESC
     LIMIT 1`,
    [transactionId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    transactionId: row.transaction_id,
    uniqueTransactionReference: row.unique_transaction_reference,
    amount: row.amount,
    currency: 'SGD',
    createdAt: row.created_at,
    companyName: row.merchant_name || 'Customer Review Team',
    recipientName: row.contact_name || 'Authorised Contact',
    recipientEmail: row.rfi_email,
    accountType: 'Organisation',
    caseId: row.case_id || null,
    currentStatus: row.case_status || row.action_status || 'New',
    assignedRole: row.assigned_role || null,
    escalationDestination: row.escalation_destination || null,
    strStatus: row.str_status || null,
  };
}

async function handleDatabaseRfiRequest(req, res) {
  if (!req.session?.user || !roleCanPerform(req.session.user.role, 'sendRfi')) {
    return forbidJson(res);
  }

  const transactionId = String(req.params.id || '').trim();
  if (!isValidTransactionId(transactionId)) {
    return res.status(400).json({ success: false, message: 'Invalid transaction ID.' });
  }

  let context;
  try {
    await ensureStrWorkflowSchema();
    context = await findDatabaseRfiContext(transactionId);
  } catch (error) {
    console.error('Unable to load database RFI context', {
      transactionId: req.params.id,
      message: error.message,
    });
    return res.status(500).json({ success: false, message: 'Unable to load transaction details' });
  }

  const access = validateRfiAccess(req.session.user.role, context);
  if (!access.allowed) return res.status(access.status).json({ success: false, message: access.message });

  const validationMessage = validateRfiRequestBody(req.body);
  if (validationMessage) {
    return res.status(400).json({ success: false, message: validationMessage });
  }
  const recipient = selectRfiDeliveryRecipient({
    savedEmail: context.recipientEmail,
    accountType: context.accountType,
  });
  if (!recipient.email) {
    return res.status(400).json({ success: false, message: 'Saved recipient email is missing' });
  }
  if (!emailService.isValidEmail(recipient.email)) {
    return res.status(400).json({ success: false, message: 'Recipient email is missing or invalid' });
  }

  await ensureNotificationSchema();
  const rfiId = id('RFI');
  const subject = String(req.body.subject || '').trim();
  const informationRequested = String(req.body.informationRequested || '').trim();
  let delivery;
  try {
    delivery = await emailService.sendRfiEmail({
      to: recipient.email,
      recipientName: context.recipientName,
      companyName: context.companyName,
      transactionId: context.transactionId,
      transactionDate: new Date(context.createdAt).toLocaleString('en-SG'),
      currency: context.currency,
      amount: context.amount,
      subject,
      informationRequested,
    });
  } catch (error) {
    console.error('RFI SMTP delivery failed', {
      transactionId: context.transactionId,
      code: error.code || 'EMAIL_SEND_FAILED',
      message: error.message,
    });
    const safeError = getSafeEmailError(error);
    try {
      await database.withTransaction(async (tx) => {
        await tx.execute(
          `INSERT INTO rfi_requests
            (rfi_id, transaction_id, case_id, sent_by, recipient_email, subject, request_summary,
             status, failure_code, failure_message, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'Failed', ?, ?, NOW(), NOW())`,
          [
            rfiId, context.transactionId, context.caseId, req.session.user.id, recipient.email,
            subject, informationRequested, safeError.code, safeError.message,
          ],
        );
        await tx.execute(
          `INSERT INTO audit_logs
            (audit_id, transaction_id, entity_type, entity_id, action, user_id, notes, created_at)
           VALUES (?, ?, 'RFI', ?, 'RFI_SEND_FAILED', ?, ?, NOW())`,
          [id('AUD'), context.transactionId, rfiId, req.session.user.id, `RFI send failed: ${safeError.code}.`],
        );
        await createNotification({
          userId: req.session.user.id,
          caseId: context.caseId,
          transactionId: context.transactionId,
          rfiId,
          type: 'RFI_FAILED',
          title: 'RFI could not be sent',
          message: `The RFI for transaction ${context.uniqueTransactionReference || context.transactionId} could not be sent. Please try again.`,
          targetUrl: `/transactions/${encodeURIComponent(context.transactionId)}#merchant-rfi-response`,
        }, tx);
      });
    } catch (persistenceError) {
      console.error('Unable to persist failed RFI notification', {
        transactionId: context.transactionId,
        message: persistenceError.message,
      });
    }
    return res.status(502).json({ success: false, ...safeError });
  }

  // Full recipient address (not masked) is recorded here on purpose: this is a permanent
  // historical snapshot of the address actually used at send time, distinct from the live
  // merchant_contacts lookup - so it still reads correctly even after a later contact edit.
  const auditSummary = [
    'RFI sent by SMTP.',
    `Recipient: ${recipient.email}.`,
    `Role: ${req.session.user.role}.`,
    `Reference: ${context.uniqueTransactionReference || context.transactionId}.`,
    delivery.messageId ? `Provider message ID: ${delivery.messageId}.` : '',
  ].filter(Boolean).join(' ');

  try {
    await database.withTransaction(async (tx) => {
      if (context.caseId) {
        await tx.execute(
          'UPDATE cases SET status = ?, last_actioned_by = ?, last_actioned_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE case_id = ?',
          ['Pending RFI', req.session.user.id, context.caseId],
        );
      }
      await tx.execute('UPDATE transactions SET action_status = ?, updated_at = CURRENT_TIMESTAMP WHERE transaction_id = ?', ['Pending RFI', context.transactionId]);
      await tx.execute(
        `INSERT INTO rfi_requests
          (rfi_id, transaction_id, case_id, sent_by, recipient_email, subject, request_summary,
           status, outbound_message_id, sent_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'Sent', ?, NOW(), NOW(), NOW())`,
        [
          rfiId, context.transactionId, context.caseId, req.session.user.id, recipient.email,
          subject, informationRequested, delivery.messageId || null,
        ],
      );
      await tx.execute(
        `INSERT INTO audit_logs (audit_id, transaction_id, entity_type, entity_id, action, user_id, notes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
        [id('AUD'), context.transactionId, 'RFI',
          rfiId, 'RFI_SENT', req.session.user.id, auditSummary],
      );
      await createNotification({
        userId: req.session.user.id,
        caseId: context.caseId,
        transactionId: context.transactionId,
        rfiId,
        type: 'RFI_SENT',
        title: 'RFI sent successfully',
        message: `The RFI for transaction ${context.uniqueTransactionReference || context.transactionId} was sent to the merchant.`,
        targetUrl: `/transactions/${encodeURIComponent(context.transactionId)}#merchant-rfi-response`,
      }, tx);
    });
  } catch (error) {
    console.error('RFI email sent but database persistence failed', {
      transactionId: context.transactionId,
      messageId: delivery.messageId || null,
      message: error.message,
    });
    return res.status(500).json({
      success: false,
      code: 'EMAIL_SENT_DATABASE_UPDATE_FAILED',
      message: 'The email was sent, but the case status and audit record could not be saved. Do not resend; contact an administrator.',
    });
  }

  return res.status(200).json({
    success: true,
    deliveryMethod: 'SMTP',
    recipient: recipient.email,
    recipientSource: recipient.source,
    messageId: delivery.messageId || null,
    rfiId,
    message: `RFI email accepted for delivery to ${recipient.email}.`,
    caseStatus: context.caseId ? 'Pending RFI' : null,
    transactionStatus: 'Pending RFI',
  });
}

module.exports = {
  selectRfiDeliveryRecipient,
  isValidTransactionId,
  validateRfiAccess,
  validateRfiRequestBody,
  handleDatabaseRfiRequest,
};
