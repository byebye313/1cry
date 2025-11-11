// backend/coins/routes.js
const express = require('express');
const router = express.Router();
const { getHotCoins, getMarketData } = require('./coins');

// Route for Hot 12 Coins (for card slider)
router.get('/hot', (req, res) => {
  const coins = getHotCoins();
  res.json(coins); // دائمًا يُرجع بيانات (حتى لو كانت وهمية)
});

// Route for All Hot Coins, Gainers, Losers, and 24H Volume
router.get('/market', (req, res) => {
  const data = getMarketData();
  res.json(data); // دائمًا يُرجع بيانات
});

router.get('/hot-coins', (req, res) => {
  const hotCoins = getHotCoins().slice(0, 20);
  res.status(200).json(hotCoins); // دائمًا يُرجع بيانات
});

router.get('/coin-details/:symbol', (req, res) => {
  const { symbol } = req.params;
  const marketData = getMarketData();
  const coin = marketData.allHotCoins.find((c) => c.symbol === symbol.toUpperCase());
  if (!coin) {
    return res.status(404).json({ message: 'Coin not found' });
  }
  res.status(200).json({
    symbol: `${coin.symbol}USDT`,
    price: coin.price,
    change: coin.change,
    volume24h: coin.volume24h,
    high24h: coin.high24h,
    low24h: coin.low24h,
  });
});

module.exports = router;