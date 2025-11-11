// backend/coins/coins.js (improved, multi-source, cache, rate-limit, circuit-breaker)
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const CACHE_FILE = path.join(__dirname, 'coins_cache.json');
const CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes cache (قابل للتعديل)
const FETCH_INTERVAL_MS = 1 * 60 * 1000; // original used 1 min; يمكنك تغييره
const USER_AGENT = '1CryptoX-Backend/1.0 (+https://www.1cryptox.com)';

let hotCoins = [];
let marketData = {
  allHotCoins: [],
  topGainers: [],
  topLosers: [],
  topVolume: [],
};

// حالات مزودين (circuit-breaker)
const providerStatus = {
  coinGecko: { failCount: 0, lastFailAt: null, disabledUntil: null },
  binance: { failCount: 0, lastFailAt: null, disabledUntil: null },
  kucoin: { failCount: 0, lastFailAt: null, disabledUntil: null },
};

// إعدادات عامة لإعادة المحاولة مع backoff
const fetchWithRetry = async (fn, { retries = 3, baseDelay = 800 } = {}) => {
  let attempt = 0;
  while (attempt < retries) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      if (attempt >= retries) throw err;
      const jitter = Math.floor(Math.random() * 300);
      const delay = baseDelay * Math.pow(2, attempt - 1) + jitter;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
};

// التحقق من ملف الكاش
const readCache = () => {
  try {
    if (!fs.existsSync(CACHE_FILE)) return null;
    const raw = fs.readFileSync(CACHE_FILE, 'utf8');
    const obj = JSON.parse(raw);
    if (Date.now() - obj._fetchedAt < CACHE_TTL_MS) return obj;
    return null;
  } catch (e) {
    return null;
  }
};

const writeCache = (payload) => {
  try {
    const toWrite = { ...payload, _fetchedAt: Date.now() };
    fs.writeFileSync(CACHE_FILE, JSON.stringify(toWrite), 'utf8');
  } catch (e) {
    console.warn('Failed to write cache:', e.message);
  }
};

// رأس موحّد للطلبات لتقليل مظهر "بوت"
const defaultRequestHeaders = () => ({
  'User-Agent': USER_AGENT,
  Accept: 'application/json, text/plain, */*',
  'Accept-Encoding': 'gzip,deflate,compress',
  'Connection': 'keep-alive',
});

// مصدر 1: CoinGecko (مستحب لعدم محدودية صارمة على endpoints العامة)
const fetchFromCoinGecko = async () => {
  // نطلب قائمة أسعار market data من CoinGecko (simple/markets)
  const url = 'https://api.coingecko.com/api/v3/coins/markets';
  const params = {
    vs_currency: 'usd',
    order: 'market_cap_desc',
    per_page: 250,
    page: 1,
    price_change_percentage: '24h',
  };
  const res = await axios.get(url, {
    params,
    timeout: 15000,
    headers: defaultRequestHeaders(),
  });
  // Map coinGecko response -> our shape (only USDT-like pairs)
  // CoinGecko gives coin ids and vs_currency is 'usd' (not USDT), but we map by symbol and return the same shape.
  const data = res.data.map((c) => ({
    symbol: (c.symbol || '').toUpperCase(), // e.g., "btc"
    price: c.current_price != null ? Number(c.current_price) : null,
    change: c.price_change_percentage_24h != null ? Number(c.price_change_percentage_24h) : 0,
    volume24h: c.total_volume != null ? Number(c.total_volume) : 0,
    high24h: c.high_24h != null ? Number(c.high_24h) : null,
    low24h: c.low_24h != null ? Number(c.low_24h) : null,
  }));
  return data;
};

// مصدر 2: Binance (ticker 24hr) — نحاول استخدامه لكن أقل تواتراً لتجنّب rate limits
const fetchFromBinance = async () => {
  const url = 'https://api.binance.com/api/v3/ticker/24hr';
  const res = await axios.get(url, {
    timeout: 15000,
    headers: defaultRequestHeaders(),
  });
  // Filter USDT symbols and map
  const data = res.data
    .filter((s) => typeof s.symbol === 'string' && s.symbol.endsWith('USDT'))
    .map((s) => ({
      symbol: s.symbol.replace(/USDT$/i, '').toUpperCase(),
      price: s.lastPrice ? Number(s.lastPrice) : null,
      change: s.priceChangePercent ? Number(s.priceChangePercent) : 0,
      volume24h: s.volume ? Number(s.volume) : 0,
      high24h: s.highPrice ? Number(s.highPrice) : null,
      low24h: s.lowPrice ? Number(s.lowPrice) : null,
    }));
  return data;
};

// مصدر ثالث: KuCoin (backup public endpoint)
const fetchFromKucoin = async () => {
  const url = 'https://api.kucoin.com/api/v1/market/allTickers';
  const res = await axios.get(url, { timeout: 15000, headers: defaultRequestHeaders() });
  // Kucoin returns pairs; filter those ending with USDT
  const tickers = res.data.data.ticker || [];
  const data = tickers
    .filter((t) => t.symbol && t.symbol.endsWith('-USDT'))
    .map((t) => ({
      symbol: t.symbol.replace(/-USDT$/i, '').toUpperCase(),
      price: t.last ? Number(t.last) : null,
      change: t.changeRate ? Number(t.changeRate) * 100 : 0,
      volume24h: t.vol ? Number(t.vol) : 0,
      high24h: t.high ? Number(t.high) : null,
      low24h: t.low ? Number(t.low) : null,
    }));
  return data;
};

// اختيار المزود المتاح (circuit breaker بسيط)
const providerAllowed = (name) => {
  const s = providerStatus[name];
  if (!s) return true;
  if (!s.disabledUntil) return true;
  return Date.now() > s.disabledUntil;
};

const markProviderFailure = (name) => {
  const s = providerStatus[name];
  if (!s) return;
  s.failCount = (s.failCount || 0) + 1;
  s.lastFailAt = Date.now();
  // لو فشل 3 مرات متتالية، نوقفه 5 دقائق
  if (s.failCount >= 3) {
    s.disabledUntil = Date.now() + 5 * 60 * 1000;
    console.warn(`${name} disabled until ${new Date(s.disabledUntil).toISOString()}`);
  }
};

const markProviderSuccess = (name) => {
  const s = providerStatus[name];
  if (!s) return;
  s.failCount = 0;
  s.lastFailAt = null;
  s.disabledUntil = null;
};

// دمج بيانات من مصادر متعددة: نحاول CoinGecko أولًا (أكثر تساهلاً)، ثم Binance ثم KuCoin
const fetchBestAvailable = async () => {
  // 1) مصفوفة المصادر مرتبة بالأولوية
  const sources = [
    { name: 'coinGecko', fn: fetchFromCoinGecko },
    { name: 'binance', fn: fetchFromBinance },
    { name: 'kucoin', fn: fetchFromKucoin },
  ];

  // 2) ننفّذ كل مصدر مع retry وcircuit-breaker
  for (const src of sources) {
    if (!providerAllowed(src.name)) continue; // تخطى المزود إذا كان disabled
    try {
      const data = await fetchWithRetry(() => src.fn(), { retries: 3, baseDelay: 700 });
      // نجاح -> إعادة تهيئة حالة المزود
      markProviderSuccess(src.name);
      return { provider: src.name, data };
    } catch (err) {
      console.warn(`Provider ${src.name} failed:`, err.message || err);
      markProviderFailure(src.name);
      // جرّب التالي
    }
  }
  // جميع المزودين فشلوا
  throw new Error('All providers failed');
};

const processAndSetMarketData = (raw) => {
  // raw: array of {symbol, price, change, volume24h, high24h, low24h}
  // تنظيف وتوحيد الرموز (uppercase, remove unwanted)
  const coins = raw
    .filter((c) => c && c.symbol && c.price != null)
    .map((c) => ({
      symbol: c.symbol.toUpperCase(),
      price: Number(c.price),
      change: Number(c.change || 0),
      volume24h: Number(c.volume24h || 0),
      high24h: c.high24h != null ? Number(c.high24h) : null,
      low24h: c.low24h != null ? Number(c.low24h) : null,
    }));

  marketData.allHotCoins = coins;
  marketData.topGainers = [...coins].sort((a, b) => b.change - a.change).slice(0, 25);
  marketData.topLosers = [...coins].sort((a, b) => a.change - b.change).slice(0, 25);
  marketData.topVolume = [...coins].sort((a, b) => b.volume24h - a.volume24h).slice(0, 25);
  hotCoins = [...coins].sort((a, b) => b.volume24h - a.volume24h).slice(0, 12);
};

// عملية جلب موحدة مع كاش وfallback
const fetchCoinsUnified = async () => {
  // 1) محاولة قراءة الكاش المحلي أولًا
  const cached = readCache();
  if (cached) {
    // استخدم الكاش فورًا لكن اطلب تحديثًا غير متزامن
    try {
      marketData = {
        allHotCoins: cached.allHotCoins || [],
        topGainers: cached.topGainers || [],
        topLosers: cached.topLosers || [],
        topVolume: cached.topVolume || [],
      };
      hotCoins = cached.hotCoins || [];
    } catch (e) {}
    // ولكن ننطلق في الخلفية لتحديث الكاش إن كان مضى وقت طويل
    setTimeout(() => {
      fetchCoinsUnifiedNoCache().catch((e) => console.warn('Background refresh failed:', e.message));
    }, 0);
    return;
  }

  // لا كاش -> اجلب مباشرة
  return fetchCoinsUnifiedNoCache();
};

const fetchCoinsUnifiedNoCache = async () => {
  try {
    const { provider, data } = await fetchBestAvailable();
    // قد تكون بيانات CoinGecko بالـ USD وليس USDT؛ لكننا نعالج الرموز فقط (BTC, ETH, ...)
    processAndSetMarketData(data);
    writeCache({
      hotCoins,
      allHotCoins: marketData.allHotCoins,
      topGainers: marketData.topGainers,
      topLosers: marketData.topLosers,
      topVolume: marketData.topVolume,
      provider,
    });
    console.log(`Coins fetched from ${provider} at ${new Date().toISOString()}`);
  } catch (err) {
    console.error('Failed to fetch from any provider:', err.message);
    // fallback بيانات محلية بسيطة (لا تتوقف الخدمة)
    if (!hotCoins || hotCoins.length === 0) {
      hotCoins = [
        { symbol: 'BTC', price: 50000, change: 2.5, volume24h: 1000000, high24h: 51000, low24h: 49000 },
        { symbol: 'ETH', price: 3000, change: 1.8, volume24h: 500000, high24h: 3100, low24h: 2900 },
        { symbol: 'BNB', price: 500, change: 3.2, volume24h: 200000, high24h: 510, low24h: 490 },
      ];
      marketData.allHotCoins = hotCoins;
      marketData.topGainers = hotCoins;
      marketData.topLosers = hotCoins;
      marketData.topVolume = hotCoins;
    }
  }
};

// تشغيل الجلب أول مرة
fetchCoinsUnified().catch((e) => {
  console.error('Initial fetch failed:', e.message);
});

// جدولة التحديث بفاصل مع إضافة jitter لتجنّب طلبات منتظمة دقيقة
const scheduleFetch = () => {
  const jitter = Math.floor(Math.random() * 15 * 1000); // حتى 15s jitter
  setTimeout(async () => {
    await fetchCoinsUnifiedNoCache();
    // بعد التنفيذ: جدولة التالية
    setInterval(fetchCoinsUnifiedNoCache, FETCH_INTERVAL_MS + Math.floor(Math.random() * 30 * 1000));
  }, jitter);
};
scheduleFetch();

// وظائف الوصول المتوافقة مع الـ routes الحالية
const getHotCoins = () => hotCoins;
const getMarketData = () => marketData;

module.exports = { getHotCoins, getMarketData };
