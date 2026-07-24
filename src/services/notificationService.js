const database = require('../database');
const { id } = require('../lib/ids');
const { ensureNotificationSchema } = require('../lib/schema');

async function createNotification({
  userId, caseId = null, transactionId = null, rfiId = null, replyFingerprint = null,
  type, title, message, targetUrl = null,
}, db = database) {
  if (!userId) return { created: false, notificationId: null };
  await ensureNotificationSchema();
  const notificationId = id('NOT');
  const [result] = await db.execute(
    `INSERT IGNORE INTO notifications
      (notification_id, user_id, case_id, transaction_id, rfi_id, reply_fingerprint,
       notification_type, title, message, target_url, is_read, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NOW())`,
    [
      notificationId, userId, caseId, transactionId, rfiId, replyFingerprint,
      type, title, message, targetUrl,
    ],
  );
  return { created: result.affectedRows === 1, notificationId: result.affectedRows === 1 ? notificationId : null };
}

async function listNotifications(userId, { limit = 8, db = database } = {}) {
  await ensureNotificationSchema();
  const safeLimit = Math.min(25, Math.max(1, Number(limit) || 8));
  const [rows] = await db.query(
    `SELECT notification_id, notification_type, title, message, target_url, is_read, created_at, read_at
     FROM notifications
     WHERE user_id = ?
     ORDER BY created_at DESC
     LIMIT ${safeLimit}`,
    [userId],
  );
  const [counts] = await db.query(
    'SELECT COUNT(*) AS unread_count FROM notifications WHERE user_id = ? AND is_read = 0',
    [userId],
  );
  return { rows, unreadCount: Number(counts[0]?.unread_count || 0) };
}

async function markNotificationRead(userId, notificationId, db = database) {
  await ensureNotificationSchema();
  const [result] = await db.execute(
    `UPDATE notifications
     SET is_read = 1, read_at = COALESCE(read_at, NOW())
     WHERE notification_id = ? AND user_id = ?`,
    [notificationId, userId],
  );
  return result.affectedRows === 1;
}

async function markAllNotificationsRead(userId, db = database) {
  await ensureNotificationSchema();
  const [result] = await db.execute(
    'UPDATE notifications SET is_read = 1, read_at = COALESCE(read_at, NOW()) WHERE user_id = ? AND is_read = 0',
    [userId],
  );
  return result.affectedRows;
}

async function listNotificationPage(userId, { page = 1, limit = 20 } = {}) {
  await ensureNotificationSchema();
  const safeLimit = Math.min(50, Math.max(1, Number(limit) || 20));
  const safePage = Math.max(1, Number(page) || 1);
  const [countRows] = await database.query(
    'SELECT COUNT(*) AS total FROM notifications WHERE user_id = ?',
    [userId],
  );
  const total = Number(countRows[0]?.total || 0);
  const totalPages = Math.max(1, Math.ceil(total / safeLimit));
  const currentPage = Math.min(safePage, totalPages);
  const offset = (currentPage - 1) * safeLimit;
  const [rows] = await database.query(
    `SELECT notification_id, notification_type, title, message, target_url, is_read, created_at, read_at
     FROM notifications
     WHERE user_id = ?
     ORDER BY created_at DESC
     LIMIT ${safeLimit} OFFSET ${offset}`,
    [userId],
  );
  return { rows, pagination: { page: currentPage, limit: safeLimit, total, totalPages } };
}

module.exports = {
  createNotification,
  listNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  listNotificationPage,
};
