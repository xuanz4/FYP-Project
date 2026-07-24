const database = require('../database');
const { ensureNotificationSchema, ensureRiskAndContactSchema } = require('../lib/schema');
const { checkRfiForReply } = require('../services/rfiMailboxService');

let running = false;

async function checkPendingRfiReplies({
  db = database,
  checkReply = checkRfiForReply,
} = {}) {
  if (running) return { skipped: true, checked: 0, replies: 0 };
  running = true;
  try {
    await ensureNotificationSchema();
    await ensureRiskAndContactSchema();
    const [rows] = await db.query(
      `SELECT rfi_id, transaction_id, case_id, sent_by, recipient_email,
              outbound_message_id, sent_at, status
       FROM rfi_requests
       WHERE status = 'Sent'
       ORDER BY sent_at ASC
       LIMIT 50`,
    );
    let replies = 0;
    for (const rfi of rows) {
      try {
        // Sequential mailbox access avoids opening many IMAP sessions at once.
        // eslint-disable-next-line no-await-in-loop
        const result = await checkReply(rfi, { db });
        if (result.detection?.created) replies += 1;
      } catch (error) {
        console.error('Automatic RFI reply check failed', {
          rfiId: rfi.rfi_id,
          transactionId: rfi.transaction_id,
          code: error.code || 'RFI_MAILBOX_CHECK_FAILED',
          message: error.message,
        });
      }
    }
    return { skipped: false, checked: rows.length, replies };
  } finally {
    running = false;
  }
}

function startRfiReplyChecker({ intervalMs = 60 * 1000 } = {}) {
  const safeInterval = Math.max(60 * 1000, Number(intervalMs) || 60 * 1000);
  const timer = setInterval(() => {
    checkPendingRfiReplies().catch((error) => {
      console.error(`RFI reply checker failed: ${error.message}`);
    });
  }, safeInterval);
  timer.unref?.();
  return timer;
}

function resetRunningForTests() {
  running = false;
}

module.exports = { checkPendingRfiReplies, startRfiReplyChecker, resetRunningForTests };
