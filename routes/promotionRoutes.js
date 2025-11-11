const express = require('express');
const router = express.Router();
const auth = require('../middlewares/authMiddleware');
// const requireSupport = require('../middlewares/');
const { uploadPromotionScreenshot } = require('../middlewares/uploadPromotionScreenshot');
const ctrl = require('../controllers/promotionController');


// User endpoints
router.post('/promotions', auth, uploadPromotionScreenshot, ctrl.createPromotion); // multipart(form-data): screenshot
router.get('/promotions/my', auth, ctrl.listMyPromotions);


// Support endpoints
router.get('/promotions/pending', auth,ctrl.listPending);
router.get('/promotions/:id/screenshot', auth, ctrl.downloadScreenshot);
router.post('/promotions/:id/review', auth, ctrl.reviewPromotion);


// Optional: metrics / leaderboard hooks
router.patch('/promotions/:id/metrics', auth,  ctrl.patchMetrics);


module.exports = router;