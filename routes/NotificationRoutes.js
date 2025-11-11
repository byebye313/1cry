const express = require('express');
const router = express.Router();
const { Notification } = require('../models/Notification');

// جلب جميع الإشعارات للمستخدم
router.get('/:user_id', async (req, res) => {
  try {
    const { user_id } = req.params;
    if (!user_id || typeof user_id !== 'string') {
      return res.status(400).json({ error: 'Invalid user_id' });
    }

    const notifications = await Notification.find({ user_id })
      .sort({ created_at: -1 }) // ترتيب حسب تاريخ الإنشاء (الأحدث أولاً)
      .limit(50); // الحد الأقصى لعدد الإشعارات المسترجعة

    res.status(200).json(notifications);
  } catch (error) {
    console.error('Error fetching notifications:', error.message, error.stack);
    res.status(500).json({ error: 'Failed to fetch notifications' });
  }
});

// تحديث حالة الإشعار من unread إلى read
router.put('/:notification_id/read', async (req, res) => {
  try {
    const { notification_id } = req.params;
    const notification = await Notification.findById(notification_id);
    if (!notification) {
      return res.status(404).json({ error: 'Notification not found' });
    }

    if (notification.is_read) {
      return res.status(400).json({ error: 'Notification already marked as read' });
    }

    notification.is_read = true;
    notification.updated_at = Date.now();
    await notification.save();

    res.status(200).json({
      message: 'Notification marked as read successfully',
      notification,
    });
  } catch (error) {
    console.error('Error marking notification as read:', error.message, error.stack);
    res.status(500).json({ error: 'Failed to mark notification as read' });
  }
});

module.exports = router;