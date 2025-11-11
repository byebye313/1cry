const express = require('express');
const router = express.Router();
const { fetchAndStoreSpotAssets, getAssets, getSpotTradingPairs, getOrderBook, getFuturesOrderBook } = require('../controllers/assetController');

router.get('/initialize-assets', fetchAndStoreSpotAssets);
router.get('/assets', getAssets);
router.get('/spot/trading-pairs', getSpotTradingPairs);
router.get('/spot/order-book/:symbol', getOrderBook);
router.get('/futures/order-book/:symbol', getFuturesOrderBook);

module.exports = router;