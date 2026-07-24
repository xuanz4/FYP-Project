const express = require('express');
const { requireAuth } = require('../src/middleware/auth');
const notificationsController = require('../controllers/notificationsController');

const router = express.Router();

router.get('/notifications', requireAuth, notificationsController.page);
router.get('/api/notifications', requireAuth, notificationsController.index);
router.get('/api/notifications/unread-count', requireAuth, notificationsController.unreadCount);
router.patch('/api/notifications/read-all', requireAuth, notificationsController.markAllRead);
router.patch('/api/notifications/:id/read', requireAuth, notificationsController.markRead);

module.exports = router;
