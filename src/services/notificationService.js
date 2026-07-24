const { id } = require('../lib/ids');
const { ensureNotificationSchema } = require('../lib/schema');
const notificationModel = require('../../models/notificationModel');

async function createNotification({
  userId, caseId = null, transactionId = null, rfiId = null, replyFingerprint = null,
  type, title, message, targetUrl = null,
}, db) {
  if (!userId) return { created: false, notificationId: null };
  await ensureNotificationSchema();
  const notificationId = id('NOT');
  const result = await notificationModel.insert(db, {
    notificationId, userId, caseId, transactionId, rfiId, replyFingerprint, type, title, message, targetUrl,
  });
  return { created: result.affectedRows === 1, notificationId: result.affectedRows === 1 ? notificationId : null };
}

async function listNotifications(userId, { limit = 8, db } = {}) {
  await ensureNotificationSchema();
  const safeLimit = Math.min(25, Math.max(1, Number(limit) || 8));
  const rows = await notificationModel.listByUserId(db, userId, safeLimit);
  const unreadCount = await notificationModel.countUnreadByUserId(db, userId);
  return { rows, unreadCount };
}

async function markNotificationRead(userId, notificationId, db) {
  await ensureNotificationSchema();
  const result = await notificationModel.markRead(db, notificationId, userId);
  return result.affectedRows === 1;
}

async function markAllNotificationsRead(userId, db) {
  await ensureNotificationSchema();
  const result = await notificationModel.markAllRead(db, userId);
  return result.affectedRows;
}

async function listNotificationPage(userId, { page = 1, limit = 20 } = {}) {
  await ensureNotificationSchema();
  const safeLimit = Math.min(50, Math.max(1, Number(limit) || 20));
  const safePage = Math.max(1, Number(page) || 1);
  const total = await notificationModel.countByUserId(userId);
  const totalPages = Math.max(1, Math.ceil(total / safeLimit));
  const currentPage = Math.min(safePage, totalPages);
  const offset = (currentPage - 1) * safeLimit;
  const rows = await notificationModel.listPageByUserId(userId, safeLimit, offset);
  return { rows, pagination: { page: currentPage, limit: safeLimit, total, totalPages } };
}

module.exports = {
  createNotification,
  listNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  listNotificationPage,
};
