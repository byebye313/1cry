// services/futuresPriceFeed.js
// HTTP-only Futures Price Poller (no WebSockets).
// - Polls Binance REST every FUTURES_POLL_MS (default 40000 ms) for *active* symbols:
//   (symbols that have Pending/Limit futures orders or Filled/open futures trades).
// - Provides getCurrentPrice / ensureCurrentPrice for controllers & engine.

const axios = require('axios');
const { FutureTrade } = require('../models/FutureTrade');
const { TradingPair } = require('../models/TradingPair');

// ============ Config ============
const FUTURES_POLL_MS     = Number(process.env.FUTURES_POLL_MS || 40000);  // 40s
const PRICE_TTL_MS        = Number(process.env.FUTURES_PRICE_TTL_MS || 15000); // consider price fresh for 15s
const HTTP_TIMEOUT_MS     = Number(process.env.FUTURES_HTTP_TIMEOUT_MS || 3500);
const RECONCILE_EVERY_MS  = Number(process.env.FUTURES_RECONCILE_MS || 60000); // 60s: rebuild active set

// Binance REST mirrors (fallback rotation)
const FUTURES_BASES = (process.env.FUTURES_BASES ||
  'https://fapi.binance.com,https://fapi1.binance.com,https://fapi2.binance.com,https://fapi3.binance.com'
).split(',').map(s => s.trim()).filter(Boolean);

// ============ State ============
const priceCache     = new Map();     // symbol => { price:number, ts:number }
const activeSymbols  = new Set();     // FUTURES symbols to poll
let pollTimer        = null;
let reconcileTimer   = null;

function _U(s) { return String(s || '').trim().toUpperCase(); }

// ============ HTTP helpers ============
async function _fetchWithFallback(path, params) {
  let lastErr;
  for (const base of FUTURES_BASES) {
    try {
      const { data } = await axios.get(`${base}${path}`, { params, timeout: HTTP_TIMEOUT_MS });
      return data;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('All futures bases failed');
}

async function _fetchPriceHTTP(symbol) {
  const s = _U(symbol);
  const data = await _fetchWithFallback('/fapi/v1/ticker/price', { symbol: s });
  const p = Number(data?.price);
  if (!isFinite(p) || p <= 0) throw new Error(`Invalid futures price for ${s}`);
  priceCache.set(s, { price: p, ts: Date.now() });
  return p;
}

// ============ Public price API ============
function getCurrentPrice(symbol) {
  const rec = priceCache.get(_U(symbol));
  if (!rec) return 0;
  if (Date.now() - rec.ts > PRICE_TTL_MS) return 0;
  return rec.price;
}

// Try cache; if missing/stale, fetch now via REST (ملاحظة: هذا قد يضرب HTTP خارج دورة 40ث إن لم يتوفر سعر حديث)
async function ensureCurrentPrice(symbol) {
  const s = _U(symbol);
  const cached = getCurrentPrice(s);
  if (cached > 0) return cached;
  const fresh = await _fetchPriceHTTP(s);
  return fresh;
}

// ============ Active symbols management ============
function addFuturesSymbol(symbol)    { activeSymbols.add(_U(symbol)); }
function removeFuturesSymbol(symbol) { activeSymbols.delete(_U(symbol)); }

// بناء مجموعة الرموز النشطة من قاعدة البيانات (Pending/Limit + Filled)
async function _reconcileActiveSymbols() {
  try {
    const pending = await FutureTrade.find({ status: 'Pending', order_type: 'Limit' })
      .select(['trading_pair_id']).limit(5000);
    const open    = await FutureTrade.find({ status: 'Filled' })
      .select(['trading_pair_id']).limit(5000);

    const allIds  = [...new Set([...pending, ...open].map(d => String(d.trading_pair_id)))];
    if (!allIds.length) { activeSymbols.clear(); return; }

    const pairs = await TradingPair.find({ _id: { $in: allIds } }).select(['symbol']);
    const symbols = pairs.map(p => _U(p.symbol));

    activeSymbols.clear();
    for (const s of symbols) activeSymbols.add(s);
  } catch (e) {
    // ignore for this cycle
  }
}

// ============ Polling loop ============
async function _pollOneSymbol(symbol) {
  try {
    await _fetchPriceHTTP(symbol);
  } catch {
    // fails: skip this cycle
  }
}

function _startPollingLoop() {
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    const list = Array.from(activeSymbols);
    for (const sym of list) {
      const jitter = Math.floor(Math.random() * 500);
      await new Promise(r => setTimeout(r, jitter));
      await _pollOneSymbol(sym);
    }
  }, FUTURES_POLL_MS);
}

function initFuturesPriceFeed() {
  // Start polling
  _startPollingLoop();
  // Initial reconcile + periodic reconcile
  _reconcileActiveSymbols().catch(() => {});
  if (reconcileTimer) clearInterval(reconcileTimer);
  reconcileTimer = setInterval(() => _reconcileActiveSymbols().catch(() => {}), RECONCILE_EVERY_MS);
  return true;
}

module.exports = {
  // init
  initFuturesPriceFeed,

  // price
  getCurrentPrice,
  ensureCurrentPrice,

  // active mgmt
  addFuturesSymbol,
  removeFuturesSymbol,
};
