// Verifies an 'RFI Reply Reviewed' evidence entry against a real, currently-in-the-mailbox
// reply before it's recorded in case_rfi_evidence - reuses the exact same transaction_id-based
// IMAP lookup rfiInboxService already performs for the "Load Response" button, so verification
// and display always agree on the same underlying email. An analyst can still mischaracterize
// what a real email says, but can no longer fabricate an email that was never received.
const crypto = require('crypto');
const { fetchLatestRfiResponse } = require('../services/rfiInboxService');

async function buildMailboxReference(transactionId) {
  const response = await fetchLatestRfiResponse({ transactionId });
  if (!response.found) return { found: false, reference: null };
  const { message } = response;
  const anchor = message.messageId
    ? `Message-ID ${message.messageId}`
    : `SHA-256 ${crypto.createHash('sha256').update(message.text || '').digest('hex')}`;
  const reference = `From ${message.from || 'unknown sender'}, dated ${message.date || 'unknown date'}. ${anchor}.`;
  return { found: true, reference };
}

module.exports = { buildMailboxReference };
