// /routes/transferRoutes.js
const express = require('express');
const router = express.Router();
const { createTransfer, getTransferHistory } = require('../controllers/transferController');

// إنشاء تحويل (USDT فقط بين جميع المحافظ)
router.post('/', createTransfer);

// جلب سجل التحويلات
router.get('/history/:user_id', getTransferHistory);

module.exports = router;