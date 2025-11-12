// services/binanceServices.js
// HTTP-only Spot Price Poller (no WebSockets).
// - Polls Binance REST every SPOT_POLL_MS (default 40000 ms) for *active* symbols
//   (symbols that have pending Spot/Limit orders).
// - Executes Spot/Limit orders when price touches condition.
// - Provides getCachedPrice / ensureSpotPrice for controllers.

const axios = require('axios');
const mongoose = require('mongoose');

const { TradingPair } = require('../models/TradingPair');
const { OrderBook } = require('../models/OrderBook');
const { SpotTrade } = require('../models/SpotTrade');
const { SpotWallet } = require('../models/SpotWallet');
const { SpotWalletBalance } = require('../models/SpotWalletBalance');
const { Notification } = require('../models/Notification');
const { Referral } = require('../models/Refferal');

// ===================== Config =====================
const SPOT_POLL_MS = Number(process.env.SPOT_POLL_MS || 40000); // 40s
const PRICE_TTL_MS = Number(process.env.PRICE_CACHE_TTL_MS || 15000); // consider price fresh for 15s
const HTTP_TIMEOUT_MS = Number(process.env.PRICE_HTTP_TIMEOUT_MS || 3500);

// REST mirrors (fallback)
const SPOT_BASES = (process.env.SPOT_BASES ||
  'https://api.binance.com,https://api1.binance.com,https://api2.binance.com,https://api3.binance.com'
).split(',').map(s => s.trim()).filter(Boolean);

// ===================== State ======================
let io; // socket.io instance (اختياري للإشعارات)
const priceMap = new Map();        // symbol => { price, ts }
const activeSpotSymbols = new Set(); // symbols having pending Spot/Limit orders
let spotTimer = null;
let reconTimer = null;

// helper
function _U(s) { return String(s || '').trim().toUpperCase(); }

// ===================== Price utils =================
function getCurrentPrice(symbol) {
  const rec = priceMap.get(_U(symbol));
  if (!rec || Date.now() - rec.ts > PRICE_TTL_MS) return 0;
  return rec.price;
}

async function _fetchWithFallback(path, params) {
  let lastErr;
  for (const base of SPOT_BASES) {
    try {
      const { data } = await axios.get(`${base}${path}`, { params, timeout: HTTP_TIMEOUT_MS });
      return data;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('All spot bases failed');
}

async function ensureCurrentPrice(symbol) {
  const s = _U(symbol);
  const cached = getCurrentPrice(s);
  if (cached > 0) return cached;

  const data = await _fetchWithFallback('/api/v3/ticker/price', { symbol: s });
  const p = Number(data?.price);
  if (!isFinite(p) || p <= 0) throw new Error(`Invalid price from REST for ${s}`);
  priceMap.set(s, { price: p, ts: Date.now() });
  return p;
}

// ===================== Spot execution ==============
async function _executeSpotTrade(trade, tradingPair, order, currentPrice) {
  // نفس منطقك السابق لكن بدون WS
  const spotWallet = await SpotWallet.findById(trade.spot_wallet_id);
  if (!spotWallet) throw new Error('Spot wallet not found');

  const baseAssetBalance = await SpotWalletBalance.findOne({
    spot_wallet_id: trade.spot_wallet_id,
    asset_id: tradingPair.base_asset_id,
  });
  const quoteAssetBalance = await SpotWalletBalance.findOne({
    spot_wallet_id: trade.spot_wallet_id,
    asset_id: tradingPair.quote_asset_id,
  });
  if (!baseAssetBalance || !quoteAssetBalance) {
    throw new Error('Asset balance not found');
  }

  const totalCost = currentPrice * order.amount;

  if (trade.trade_type === 'Buy') {
    quoteAssetBalance.balance -= totalCost;
    baseAssetBalance.balance = (baseAssetBalance.balance || 0) + trade.amount;
  } else {
    baseAssetBalance.balance -= trade.amount;
    quoteAssetBalance.balance = (quoteAssetBalance.balance || 0) + totalCost;
  }

  trade.executed_price = currentPrice;
  trade.total_cost = totalCost;
  trade.status = 'Filled';
  order.status = 'Filled';

  await Promise.all([
    quoteAssetBalance.save(),
    baseAssetBalance.save(),
    trade.save(),
    order.save(),
  ]);

  // Referral check (كما هو)
  try {
    const referral = await Referral.findOne({ referred_user_id: trade.user_id, status: 'Pending' });
    if (referral && totalCost >= 50) {
      referral.status = 'Eligible';
      referral.trade_met = true;
      referral.trade_amount = totalCost;
      await referral.save();

      await new Notification({
        user_id: referral.referrer_id,
        type: 'Referral',
        title: 'Referral Status Updated',
        message: `Your referral's trade of ${totalCost} USDT has met the 50 USDT minimum. Status updated to Eligible!`,
        is_read: false,
      }).save();
    }
  } catch {}

  await new Notification({
    user_id: trade.user_id,
    type: 'SpotTrade',
    title: `Limit ${trade.trade_type === 'Buy' ? 'Buy' : 'Sell'} Executed`,
    message: `Order ${tradingPair.symbol} executed at ${currentPrice} (amount: ${order.amount}).`,
    is_read: false,
  }).save();

  io?.emit('order_status_update', {
    trade_id: trade._id.toString(),
    status: trade.status,
    symbol: tradingPair.symbol,
    executed_price: trade.executed_price,
    total_cost: trade.total_cost,
    timestamp: new Date().toISOString(),
  });
}

async function _executeSpotLimitOrdersForSymbol(symbol, currentPrice) {
  const pair = await TradingPair.findOne({ symbol });
  if (!pair) return;

  const pending = await OrderBook.find({
    trading_pair_id: pair._id,
    order_type: 'Spot',
    status: 'Pending',
  }).limit(500);

  if (!pending.length) {
    // لا أوامر لهذا الرمز — أزله من النشط
    activeSpotSymbols.delete(symbol);
    return;
  }

  for (const order of pending) {
    const trade = await SpotTrade.findById(order.trade_id);
    if (!trade) continue;

    const canExecute =
      (order.trade_type === 'Buy'  && currentPrice <= order.price) ||
      (order.trade_type === 'Sell' && currentPrice >= order.price);

    if (!canExecute) continue;

    await _executeSpotTrade(trade, pair, order, currentPrice);
  }
}

// ===================== Polling logic =================
async function _pollOneSpotSymbol(symbol) {
  // جلب السعر + تنفيذ أوامر الرمز
  try {
    const price = await ensureCurrentPrice(symbol);
    if (!price || price <= 0) return;
    await _executeSpotLimitOrdersForSymbol(symbol, price);
  } catch (e) {
    // فشل REST — نتخطّى هذه الدورة فقط
    // يمكن إضافة backoff/jitter من ENV لاحقًا لو رغبت
  }
}

function _startSpotPollingLoop() {
  if (spotTimer) return;
  spotTimer = setInterval(async () => {
    const list = Array.from(activeSpotSymbols);
    for (const sym of list) {
      const jitter = Math.floor(Math.random() * 500); // تفادي burst
      await new Promise(r => setTimeout(r, jitter));
      await _pollOneSpotSymbol(sym);
    }
  }, SPOT_POLL_MS);
}

async function _reconcileActiveSpotSymbols() {
  // بناء قائمة الرموز النشطة من قاعدة البيانات (كل دقيقة)
  try {
    const pendingOrders = await OrderBook.find({ order_type: 'Spot', status: 'Pending' })
      .select(['trading_pair_id']).limit(5000);
    const pairIds = [...new Set(pendingOrders.map(o => String(o.trading_pair_id)))];
    if (!pairIds.length) {
      activeSpotSymbols.clear();
      return;
    }
    const pairs = await TradingPair.find({ _id: { $in: pairIds } }).select(['symbol']);
    const symbols = pairs.map(p => _U(p.symbol));
    // حدّث المجموعة
    activeSpotSymbols.clear();
    for (const s of symbols) activeSpotSymbols.add(s);
  } catch (e) {
    // تجاهل مؤقتًا
  }
}

function addSpotSymbol(symbol)    { activeSpotSymbols.add(_U(symbol)); }
function removeSpotSymbol(symbol) { activeSpotSymbols.delete(_U(symbol)); }

function initializeSpotPolling(ioInstance) {
  io = ioInstance;
  // تشغيل البولّينغ
  _startSpotPollingLoop();
  // Reconcile دوري لالتقاط أوامر منشأة من عقد أخرى
  if (reconTimer) clearInterval(reconTimer);
  _reconcileActiveSpotSymbols().catch(() => {});
  reconTimer = setInterval(() => _reconcileActiveSpotSymbols().catch(() => {}), 60_000);
}

module.exports = {
  // init
  initializeSpotPolling,

  // price helpers
  getCurrentPrice,
  ensureCurrentPrice,

  // active sets (يستدعيها الكنترولر عند إنشاء/إلغاء أوامر)
  addSpotSymbol,
  removeSpotSymbol,
};
