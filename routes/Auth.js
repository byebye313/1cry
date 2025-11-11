// routes/Auth.js
const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');

// Existing
router.post('/register', authController.register);
router.post('/login', authController.login);
router.post('/verify-otp', authController.verifyOtp);
router.post('/logout', authController.logout);

// Forgot Password (OTP)
router.post('/forgot-password', authController.requestPasswordReset); // طلب إرسال OTP
router.post('/verify-reset-otp', authController.verifyResetOtp);      // التحقق من OTP
router.post('/reset-password', authController.resetPassword);         // تعيين كلمة المرور الجديدة

module.exports = router;
