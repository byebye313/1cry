// routes/withdrawalRoutes.js
const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/withdrawalController');
const auth = require('../middlewares/authMiddleware');

// تمرير io
router.use((req, _, next) => { req.io = req.app.get('io'); next(); });

// Quote قبل الإرسال
router.get('/fee-quote', auth, ctrl.getFeeQuote);

// User
router.post('/', auth, ctrl.createWithdrawal);
router.get('/mine', auth, ctrl.getMyWithdrawals);

// Support
router.get('/', auth, ctrl.getAllWithdrawals);
router.patch('/:id/approve', auth, ctrl.approveWithdrawal);
router.patch('/:id/reject', auth, ctrl.rejectWithdrawal);
router.patch('/:id/complete', auth, ctrl.completeWithdrawal);

module.exports = router;
