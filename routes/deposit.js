const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const depositController = require('../controllers/depositController');

router.get('/available', authMiddleware, depositController.getAvailableDeposits);
router.post('/', authMiddleware, depositController.createDeposit);
router.post('/verify', authMiddleware, depositController.verifyDeposit);

module.exports = router;