const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { suite, runTest, finish } = require('./runAll');
const {
  isMatchingRfiReply,
  recordDetectedReply,
} = require('../src/services/rfiMailboxService');
const {
  markNotificationRead,
  listNotifications,
} = require('../src/services/notificationService');
const {
  checkPendingRfiReplies,
  resetRunningForTests,
} = require('../src/jobs/rfiReplyChecker');

const rfi = {
  rfi_id: 'RFI-1',
  transaction_id: 'TXN-2026-000040',
  case_id: 'CASE-1',
  sent_by: 'USR-001',
  recipient_email: 'merchant@example.test',
  outbound_message_id: '<outbound-1@example.test>',
  status: 'Sent',
};

function mailbox(overrides = {}) {
  return {
    found: true,
    account: 'compliance@example.test',
    message: {
      from: 'Merchant Contact <merchant@example.test>',
      subject: 'Re: Request TXN-2026-000040',
      date: 'Fri, 24 Jul 2026 15:00:00 +0800',
      messageId: '<reply-1@example.test>',
      inReplyTo: '<outbound-1@example.test>',
      references: '<outbound-1@example.test>',
      text: 'Please find the requested information for TXN-2026-000040.',
      ...overrides,
    },
  };
}

function testReplyMatching() {
  assert.strictEqual(isMatchingRfiReply(rfi, mailbox()), true);
  assert.strictEqual(isMatchingRfiReply(rfi, mailbox({ from: 'Other <other@example.test>' })), false);
  assert.strictEqual(isMatchingRfiReply(rfi, mailbox({
    from: 'Compliance <compliance@example.test>',
    messageId: '<outbound-1@example.test>',
  })), false);
  assert.strictEqual(isMatchingRfiReply(rfi, mailbox({
    inReplyTo: '',
    references: '',
    subject: 'Unrelated message',
    text: 'No matching reference.',
  })), false);
}

async function testReplyPersistenceIsIdempotent() {
  let receiptAttempts = 0;
  let notificationInserts = 0;
  const db = {
    async execute(sql) {
      if (sql.includes('INSERT IGNORE INTO rfi_email_receipts')) {
        receiptAttempts += 1;
        return [{ affectedRows: receiptAttempts === 1 ? 1 : 0 }];
      }
      if (sql.includes('INSERT IGNORE INTO notifications')) notificationInserts += 1;
      return [{ affectedRows: 1 }];
    },
    async query(sql) {
      if (sql.includes('assigned_to')) return [[{ assigned_to: 'USR-002' }]];
      return [[]];
    },
  };
  const first = await recordDetectedReply(rfi, mailbox(), { db });
  const second = await recordDetectedReply(rfi, mailbox(), { db });
  assert.strictEqual(first.created, true);
  assert.strictEqual(second.created, false);
  assert.strictEqual(notificationInserts, 2);
}

async function testNotificationOwnershipAndUnreadCount() {
  const calls = [];
  const db = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('COUNT(*)')) return [[{ unread_count: 1 }]];
      return [[[{ notification_id: 'NOT-1', user_id: 'USR-001' }]]];
    },
    async execute(sql, params) {
      calls.push({ sql, params });
      return [{ affectedRows: params[1] === 'USR-001' ? 1 : 0 }];
    },
  };
  const listed = await listNotifications('USR-001', { db });
  assert.strictEqual(listed.unreadCount, 1);
  assert(calls[0].sql.includes('WHERE user_id = ?'));
  assert.strictEqual(await markNotificationRead('USR-001', 'NOT-1', db), true);
  assert.strictEqual(await markNotificationRead('USR-999', 'NOT-1', db), false);
}

async function testBackgroundFailureDoesNotEscape() {
  resetRunningForTests();
  const db = {
    async query() { return [[rfi]]; },
  };
  const result = await checkPendingRfiReplies({
    db,
    checkReply: async () => { throw new Error('mailbox unavailable'); },
  });
  assert.deepStrictEqual(result, { skipped: false, checked: 1, replies: 0 });
}

function testNotificationUiContracts() {
  const sidebar = fs.readFileSync(path.join(__dirname, '..', 'views', 'partials', 'sidebar.ejs'), 'utf8');
  const client = fs.readFileSync(path.join(__dirname, '..', 'public', 'notifications.js'), 'utf8');
  const page = fs.readFileSync(path.join(__dirname, '..', 'views', 'notifications.ejs'), 'utf8');
  const routes = fs.readFileSync(path.join(__dirname, '..', 'routes', 'notifications.js'), 'utf8');
  assert.match(sidebar, /global-account-tools/);
  assert.match(sidebar, /data-notification-filter="all"/);
  assert.match(sidebar, /data-notification-filter="unread"/);
  assert.match(sidebar, /href="\/notifications"/);
  assert.match(client, /event\.key === 'Escape'/);
  assert.match(client, /setCount\(Math\.max\(0, unreadTotal - 1\)\)/);
  assert.match(client, /#merchant-rfi-response|target_url/);
  assert.match(page, /data-page-notification-id/);
  assert.match(routes, /router\.get\('\/notifications'/);
}

async function main() {
  suite('RFI Notifications');
  await runTest('matches replies and rejects unrelated or outbound email', testReplyMatching);
  await runTest('records a matching reply only once and avoids duplicate notifications', testReplyPersistenceIsIdempotent);
  await runTest('scopes notification reads and unread counts to the current user', testNotificationOwnershipAndUnreadCount);
  await runTest('contains mailbox failures without crashing the background checker', testBackgroundFailureDoesNotEscape);
  await runTest('provides top-right dropdown filters and the full notifications page', testNotificationUiContracts);
  finish();
}

main();
