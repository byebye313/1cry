const express = require('express');
const { startTrade, getCurrentPriceAndPrediction, stopTrade, payForPrediction, getTrades, cancelRemainingTrades, generateTradeImage } = require('../controllers/aiTradeController');
const authMiddleware = require('../middlewares/authMiddleware');

const router = express.Router();

router.post('/trade', authMiddleware, startTrade);
router.get('/price-prediction', authMiddleware, getCurrentPriceAndPrediction);
router.post('/pay-for-prediction', authMiddleware, payForPrediction);
router.post('/stop', authMiddleware, stopTrade);
router.get('/trades', authMiddleware, getTrades);
router.post('/cancel-remaining', authMiddleware, cancelRemainingTrades);
router.get('/trade/:tradeId/share', generateTradeImage);

module.exports = router;