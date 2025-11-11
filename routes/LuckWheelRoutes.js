const express = require('express');
const router = express.Router();
const { spinWheel, getSpinHistory } = require('../controllers/luckWheelController');

// Route to spin the wheel (protected, one per day)
router.post('/spin', spinWheel);

// Route to get user's spin history
router.get('/history/:userId', getSpinHistory);

module.exports = router;