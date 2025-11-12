// services/futuresPriceFeed.js
// Dynamic price feed: watch only symbols used by OPEN FutureTrades

const WebSocket = require('ws');
const axios = require('axios');

const BINANCE_WS_BASE = 'wss://stream.binance.com:9443/ws';
const BINANCE_REST_BASE = 'https://api.binance.com';
const PRICE_TTL_MS = 7_000; // cache TTL
const HEARTBEAT_MS = 25_000;

const priceMap = new Map();      // symbol => { price, ts }
const sockets = new Map();       // symbol => ws
const refCounts = new Map();     // symbol => number of open trades using it

function _norm(symbol) {
  return String(symbol || '').trim().toUpperCase();
}

function getCurrentPrice(symbol) {
  const s = _norm(symbol);
  const rec = priceMap.get(s);
  if (!rec) return null;
  if (Date.now() - rec.ts > PRICE_TTL_MS) return null;
  return rec.price;
}

async function ensureCurrentPrice(symbol) {
  const s = _norm(symbol);
  const c = getCurrentPrice(s);
  if (c && c > 0) return c;

  const { data } = await axios.get(`${BINANCE_REST_BASE}/api/v3/ticker/price`, {
    params: { symbol: s },
    timeout: 3500,
  });
  const p = Number(data.price);
  if (isFinite(p) && p > 0) {
    priceMap.set(s, { price: p, ts: Date.now() });
    return p;
  }
  return null;
}

function _bindWS(symbol) {
  const s = _norm(symbol);
  if (sockets.has(s)) return; // already connected
  const ws = new WebSocket(`${BINANCE_WS_BASE}/${s.toLowerCase()}@trade`);

  let heartbeat;
  ws.on('open', () => {
    heartbeat = setInterval(() => {
      try { ws.ping(); } catch {}
    }, HEARTBEAT_MS);
  });

  ws.on('message', (buf) => {
    try {
      const msg = JSON.parse(buf.toString());
      const p = Number(msg.p);
      if (isFinite(p) && p > 0) {
        priceMap.set(s, { price: p, ts: Date.now() });
      }
    } catch {}
  });

  ws.on('error', () => { /* noop, auto-retry on close */ });

  ws.on('close', () => {
    try { clearInterval(heartbeat); } catch {}
    sockets.delete(s);
    if ((refCounts.get(s) || 0) > 0) {
      setTimeout(() => _bindWS(s), 1000);
    }
  });

  sockets.set(s, ws);
}

function _maybeCloseWS(symbol) {
  const s = _norm(symbol);
  const r = refCounts.get(s) || 0;
  if (r <= 0) {
    const ws = sockets.get(s);
    if (ws) {
      try { ws.close(); } catch {}
      sockets.delete(s);
    }
  }
}

/** احجز مراقبة السعر لزوج معيّن (صفقات مفتوحة عليه) */
function watchSymbolForTrade(symbol) {
  const s = _norm(symbol);
  const prev = refCounts.get(s) || 0;
  refCounts.set(s, prev + 1);
  if (prev === 0) _bindWS(s);
}

/** ألغِ حجز المراقبة عند إغلاق/حذف الصفقة */
function unwatchSymbolForTrade(symbol) {
  const s = _norm(symbol);
  const prev = refCounts.get(s) || 0;
  const next = Math.max(0, prev - 1);
  refCounts.set(s, next);
  if (next === 0) _maybeCloseWS(s);
}

function initFuturesPriceFeed() {
  // نبدأ فارغين؛ الإدارة تتم عبر watch/unwatch
  return true;
}

module.exports = {
  initFuturesPriceFeed,
  getCurrentPrice,
  ensureCurrentPrice,
  watchSymbolForTrade,
  unwatchSymbolForTrade,
};
