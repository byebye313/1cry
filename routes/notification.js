const express = require('express');
const router = express.Router();
const Notification = require('../models/Notification'); 
const { User } = require('../models/user');

// POST: Create a new notification
router.post('/notifications', async (req, res) => {
    try {
        const { userId, title, content } = req.body;

        // Check if the user exists
        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        // Create a new notification
        const notification = new Notification({
            userId,
            title,
            content,
        });

        // Save the notification
        await notification.save();

        res.status(201).json({ message: 'Notification created successfully', notification });
    } catch (err) {
        res.status(500).json({ message: 'Server error', error: err.message });
    }
});

// GET: Get all notifications for a specific user
router.get('/notifications/:userId', async (req, res) => {
    try {
        const { userId } = req.params;

        // Check if the user exists
        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        // Find all notifications for the user
        const notifications = await Notification.find({ userId });

        res.status(200).json({ notifications });
    } catch (err) {
        res.status(500).json({ message: 'Server error', error: err.message });
    }
});

module.exports = router;
