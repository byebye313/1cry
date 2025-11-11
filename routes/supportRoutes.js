const express = require('express');
const router = express.Router();
const {
  createSupportRequest,
  createSupportSession,
  sendSupportMessage,
  closeSupportSession,
  getSupportRequests,
  getPendingSupportRequests,
  getSupportMessages,
  createCannedResponse,
  getCannedResponses,
  getSupportSessions,
  deleteSupportSession
} = require('../controllers/supportController');

// تحويل الملف إلى دالة تقبل io
module.exports = (io) => {  
  // إنشاء طلب دعم مع رسالة أولية
  router.post('/request', createSupportRequest);

  // بدء جلسة دعم (تمرير io)
  router.post('/session', (req, res) => createSupportSession(req, res, io));

  // إرسال رسالة في جلسة دعم
  router.post('/message', sendSupportMessage);

  // إغلاق جلسة دعم مع تقييم اختياري
  router.put('/session/:session_id/close', closeSupportSession);

  // جلب طلبات الدعم للمستخدم
  router.get('/requests/:user_id', getSupportRequests);

  // جلب طلبات الدعم المعلقة لعملاء الدعم
  router.get('/pending', getPendingSupportRequests);

  // جلب رسائل جلسة دعم
  router.get('/messages/:session_id', getSupportMessages);

  // إنشاء رد جاهز
  router.post('/canned-response', createCannedResponse);

  // جلب الردود الجاهزة
  router.get('/canned-responses', getCannedResponses);

  router.get('/sessions/:user_id', getSupportSessions); // أضف هذا المسار

  router.delete('/session/:session_id', deleteSupportSession); // أضف هذا المسار

  return router;
};