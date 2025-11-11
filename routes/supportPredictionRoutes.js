// routes/supportPredictionRoutes.js
const express = require('express');
const router = express.Router();
const { upsertSupportPrediction } = require('../controllers/supportPredictionController');


// يجب تمرير auth middleware قبل هذا الراوتر في ملف السيرفر
router.post('/prediction', upsertSupportPrediction);

module.exports = router;
