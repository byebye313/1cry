// routes/futuresTradeRoutes.js
const express = require('express');
const router = express.Router();
const auth = require('../middlewares/authMiddleware');
const futuresTradeController = require('../controllers/futuresTradeController');

// Create new futures trade (Market or Limit)
router.post('/trade', futuresTradeController.createFutureTrade);

// Close filled position (reduce-only full)
router.post('/close/:trade_id', futuresTradeController.closeFutureTrade);

// Cancel pending limit order
router.post('/cancel/:trade_id', futuresTradeController.cancelFutureTrade);

// History and open trades
router.get('/history/:user_id', futuresTradeController.getFutureTradeHistory);
router.get('/open/:user_id', futuresTradeController.getOpenFutureTrades);

module.exports = router;
