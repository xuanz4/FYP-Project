const {
  listNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  listNotificationPage,
} = require('../src/services/notificationService');
const { logAdminAudit } = require('../src/lib/auditLog');

async function index(req, res) {
  const result = await listNotifications(req.session.user.id, { limit: req.query.limit });
  return res.json({ success: true, notifications: result.rows, unreadCount: result.unreadCount });
}

async function unreadCount(req, res) {
  const result = await listNotifications(req.session.user.id, { limit: 1 });
  return res.json({ success: true, unreadCount: result.unreadCount });
}

async function page(req, res) {
  const result = await listNotificationPage(req.session.user.id, { page: req.query.page, limit: 20 });
  return res.render('notifications', {
    title: 'Notifications',
    activePage: 'notifications',
    currentUser: req.session.user,
    rows: result.rows,
    pagination: result.pagination,
  });
}

async function markRead(req, res) {
  const notificationId = String(req.params.id || '').trim();
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(notificationId)) {
    return res.status(400).json({ success: false, message: 'Invalid notification ID.' });
  }
  const updated = await markNotificationRead(req.session.user.id, notificationId);
  if (!updated) return res.status(404).json({ success: false, message: 'Notification not found.' });
  await logAdminAudit({
    action: 'NOTIFICATION_READ',
    userId: req.session.user.id,
    entityType: 'Notification',
    entityId: notificationId,
    notes: 'Notification marked as read.',
  });
  return res.json({ success: true });
}

async function markAllRead(req, res) {
  const updated = await markAllNotificationsRead(req.session.user.id);
  if (updated > 0) {
    await logAdminAudit({
      action: 'NOTIFICATION_READ',
      userId: req.session.user.id,
      entityType: 'Notification',
      entityId: 'ALL',
      notes: `${updated} notifications marked as read.`,
    });
  }
  return res.json({ success: true, updated });
}

module.exports = { page, index, unreadCount, markRead, markAllRead };
