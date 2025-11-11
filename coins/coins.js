// backend/coins/coins.js
const axios = require('axios');

let hotCoins = [];
let marketData = {
  allHotCoins: [],
  topGainers: [],
  topLosers: [],
  topVolume: [],
};

// دالة مساعدة لإعادة المحاولة
const fetchWithRetry = async (url, retries = 3, delay = 2000) => {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await axios.get(url, { timeout: 15000 });
      return response;
    } catch (error) {
      if (i === retries - 1) throw error;
      console.warn(`محاولة ${i + 1} فشلت، جارٍ إعادة المحاولة بعد ${delay} مللي ثانية...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
};

const fetchCoinsFromBinance = async () => {
  try {
    const response = await fetchWithRetry('https://api.binance.com/api/v3/ticker/24hr');
    const data = response.data;

    const coins = data
      .filter((coin) => coin.symbol.endsWith('USDT'))
      .map((coin) => ({
        symbol: coin.symbol.replace('USDT', ''),
        price: parseFloat(coin.lastPrice),
        change: parseFloat(coin.priceChangePercent),
        volume24h: parseFloat(coin.volume),
        high24h: parseFloat(coin.highPrice),
        low24h: parseFloat(coin.lowPrice),
      }));

    hotCoins = coins
      .sort((a, b) => b.volume24h - a.volume24h)
      .slice(0, 12);

    marketData.allHotCoins = coins;
    marketData.topGainers = [...coins]
      .sort((a, b) => b.change - a.change)
      .slice(0, 25);
    marketData.topLosers = [...coins]
      .sort((a, b) => a.change - b.change)
      .slice(0, 25);
    marketData.topVolume = [...coins]
      .sort((a, b) => b.volume24h - a.volume24h)
      .slice(0, 25);

    console.log('Coins fetched and updated from Binance:', new Date().toISOString());
  } catch (error) {
    console.error('Error fetching coins from Binance:', error.message);
    // استخدام بيانات وهمية مؤقتًا في حالة الفشل
    hotCoins = [
      { symbol: 'BTC', price: 50000, change: 2.5, volume24h: 1000000, high24h: 51000, low24h: 49000 },
      { symbol: 'ETH', price: 3000, change: 1.8, volume24h: 500000, high24h: 3100, low24h: 2900 },
      { symbol: 'BNB', price: 500, change: 3.2, volume24h: 200000, high24h: 510, low24h: 490 },
    ];
    marketData.allHotCoins = hotCoins;
    marketData.topGainers = hotCoins;
    marketData.topLosers = hotCoins;
    marketData.topVolume = hotCoins;
    console.log('Using fallback data due to Binance API failure');
  }
};

// جلب البيانات عند بدء الخادم
fetchCoinsFromBinance();

// تحديث البيانات كل 5 دقائق
setInterval(fetchCoinsFromBinance, 1 * 60 * 1000);

const getHotCoins = () => hotCoins;
const getMarketData = () => marketData;

module.exports = { getHotCoins, getMarketData };