const database = require('../src/database');

// Accepts an optional db client (see merchantModel.findRiskTierById) so controllers/jobs that
// inject their own (real database, or a test's fake) share this seam.
async function insert(db, {
  notificationId, userId, caseId, transactionId, rfiId, replyFingerprint, type, title, message, targetUrl,
}) {
  const client = db || database;
  const [result] = await client.execute(
    `INSERT IGNORE INTO notifications
      (notification_id, user_id, case_id, transaction_id, rfi_id, reply_fingerprint,
       notification_type, title, message, target_url, is_read, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NOW())`,
    [notificationId, userId, caseId, transactionId, rfiId, replyFingerprint, type, title, message, targetUrl],
  );
  return result;
}

async function listByUserId(db, userId, limit) {
  const client = db || database;
  const [rows] = await client.query(
    `SELECT notification_id, notification_type, title, message, target_url, is_read, created_at, read_at
     FROM notifications
     WHERE user_id = ?
     ORDER BY created_at DESC
     LIMIT ${limit}`,
    [userId],
  );
  return rows;
}

async function countUnreadByUserId(db, userId) {
  const client = db || database;
  const [rows] = await client.query(
    'SELECT COUNT(*) AS unread_count FROM notifications WHERE user_id = ? AND is_read = 0',
    [userId],
  );
  return Number(rows[0]?.unread_count || 0);
}

async function markRead(db, notificationId, userId) {
  const client = db || database;
  const [result] = await client.execute(
    `UPDATE notifications
     SET is_read = 1, read_at = COALESCE(read_at, NOW())
     WHERE notification_id = ? AND user_id = ?`,
    [notificationId, userId],
  );
  return result;
}

async function markAllRead(db, userId) {
  const client = db || database;
  const [result] = await client.execute(
    'UPDATE notifications SET is_read = 1, read_at = COALESCE(read_at, NOW()) WHERE user_id = ? AND is_read = 0',
    [userId],
  );
  return result;
}

async function countByUserId(userId) {
  const [rows] = await database.query('SELECT COUNT(*) AS total FROM notifications WHERE user_id = ?', [userId]);
  return Number(rows[0]?.total || 0);
}

async function listPageByUserId(userId, limit, offset) {
  const [rows] = await database.query(
    `SELECT notification_id, notification_type, title, message, target_url, is_read, created_at, read_at
     FROM notifications
     WHERE user_id = ?
     ORDER BY created_at DESC
     LIMIT ${limit} OFFSET ${offset}`,
    [userId],
  );
  return rows;
}

module.exports = {
  insert, listByUserId, countUnreadByUserId, markRead, markAllRead, countByUserId, listPageByUserId,
};
