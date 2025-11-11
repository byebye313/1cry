const express = require('express');
const router = express.Router();
const axios = require('axios');
const {
  createSpotTrade,
  cancelSpotTrade,
  getTradeHistory,
  getOpenOrders,
} = require('../controllers/spotTradeController');
const { TradingPair } = require('../models/TradingPair');
const { Asset } = require('../models/Asset');

// إنشاء صفقة فورية
router.post('/trade', createSpotTrade);

// إلغاء صفقة فورية
router.put('/trade/:trade_id/cancel', cancelSpotTrade);

// جلب سجل الصفقات لمستخدم معين
router.get('/history/:user_id', getTradeHistory);

// جلب الأوامر المفتوحة لمستخدم معين
router.get('/open-orders/:user_id', getOpenOrders);

// جلب أو إنشاء زوج تداول بناءً على الرمز (مثل BTC لـ BTCUSDT)
router.get('/trading-pair/:symbol', async (req, res) => {
  const { symbol } = req.params;
  try {
    // التحقق من أن الرمز صالح (يجب ألا يحتوي على USDT)
    if (!symbol || symbol.toUpperCase() === 'USDT') {
      return res.status(400).json({ message: 'الرمز غير صالح. يرجى تحديد رمز الأصل الأساسي (مثل BTC)' });
    }

    // جلب الأصل الأساسي (base asset)
    const baseAsset = await Asset.findOne({ symbol: symbol.toUpperCase() });
    if (!baseAsset) {
      return res.status(404).json({ message: `الأصل الأساسي ${symbol} غير موجود` });
    }

    // جلب الأصل المقابل (quote asset)
    const quoteAsset = await Asset.findOne({ symbol: 'USDT' });
    if (!quoteAsset) {
      return res.status(404).json({ message: 'الأصل المقابل USDT غير موجود' });
    }

    // إنشاء رمز زوج التداول (مثل BTCUSDT)
    const tradingPairSymbol = `${symbol.toUpperCase()}USDT`;

    // البحث عن زوج التداول أو إنشاء واحد جديد
    let tradingPair = await TradingPair.findOne({ symbol: tradingPairSymbol });
    if (!tradingPair) {
      console.log(`إنشاء زوج تداول جديد: ${tradingPairSymbol}`);
      tradingPair = new TradingPair({
        symbol: tradingPairSymbol,
        base_asset_id: baseAsset._id,
        quote_asset_id: quoteAsset._id,
      });
      await tradingPair.save();
    }

    res.status(200).json({ trading_pair_id: tradingPair._id, symbol: tradingPairSymbol });
  } catch (error) {
    console.error(`خطأ في جلب/إنشاء زوج التداول لـ ${symbol}:`, error.message);
    res.status(500).json({ message: 'خطأ في جلب أو إنشاء زوج التداول', error: error.message });
  }
});

// جلب السعر الحالي لزوج تداول معين من Binance
router.get('/price/:symbol', async (req, res) => {
  const { symbol } = req.params;
  try {
    // التحقق من أن الرمز صالح
    if (!symbol || !/^[A-Z]+USDT$/.test(symbol.toUpperCase())) {
      return res.status(400).json({ message: 'رمز زوج التداول غير صالح. يجب أن يكون مثل BTCUSDT' });
    }

    console.log(`جلب السعر لـ ${symbol}`);
    const response = await axios.get(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol.toUpperCase()}`);
    const price = parseFloat(response.data.price);

    if (isNaN(price) || price <= 0) {
      return res.status(400).json({ message: 'السعر الحالي غير صالح' });
    }

    res.status(200).json({ price });
  } catch (error) {
    console.error(`خطأ في جلب السعر لـ ${symbol}:`, error.message);
    res.status(500).json({ message: 'فشل جلب السعر الحالي من Binance', error: error.message });
  }
});

module.exports = router;