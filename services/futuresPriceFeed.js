// services/futuresPriceFeed.js
const WebSocket = require('ws');
const axios = require('axios');
const { TradingPair } = require('../models/TradingPair');

const priceMap = new Map();

// —— إعدادات —— //
const BINANCE_WS = 'wss://stream.binance.com:9443/stream';
const HTTP_PRICE = (sym) => `https://api.binance.com/api/v3/ticker/price?symbol=${sym}`;
const RECONNECT_BASE_MS = 1500;

let ws = null;
let reconnectAttempts = 0;
let subscribedSymbols = [];
let connecting = false;

async function fetchPriceHTTP(symbol) {
  const { data } = await axios.get(HTTP_PRICE(symbol));
  const p = parseFloat(data?.price);
  if (!Number.isFinite(p) || p <= 0) throw new Error('Invalid price');
  priceMap.set(symbol, p);
  return p;
}

function buildCombinedUrl(symbols) {
  const streams = symbols.map((s) => `${s.toLowerCase()}@ticker`).join('/');
  return `${BINANCE_WS}?streams=${streams}`;
}

function safeCloseSocket() {
  try { ws?.removeAllListeners?.(); } catch {}
  try { ws?.close?.(); } catch {}
  ws = null;
}

async function openCombinedSocket(symbols) {
  if (connecting) return;
  connecting = true;

  safeCloseSocket();

  const url = buildCombinedUrl(symbols);
  ws = new WebSocket(url);

  ws.on('open', () => {
    reconnectAttempts = 0;
    connecting = false;
  });

  ws.on('message', (raw) => {
    try {
      // رسالة الـ combined stream شكلها: { stream: "btcusdt@ticker", data: {...} }
      const msg = JSON.parse(raw);
      const data = msg?.data || msg; // احتياطًا
      const symbol = (data?.s || '').toUpperCase();
      const price = parseFloat(data?.c);
      if (symbol && Number.isFinite(price) && price > 0) {
        priceMap.set(symbol, price);
      }
    } catch {}
  });

  ws.on('error', () => {
    // نحاول جلب الأسعار الأساسية عبر HTTP لبعض الرموز لتفادي انقطاع كامل
    symbols.slice(0, 5).forEach((s) => fetchPriceHTTP(s).catch(() => {}));
  });

  ws.on('close', async () => {
    connecting = false;
    const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, reconnectAttempts++), 15000);
    setTimeout(() => openCombinedSocket(symbols), delay);
  });
}

async function initFuturesPriceFeed() {
  // اجلب الرموز مرة واحدة فقط
  const pairs = await TradingPair.find({}, { symbol: 1, _id: 0 }).lean();
  subscribedSymbols = (pairs || [])
    .map((p) => (p.symbol || '').toUpperCase())
    .filter(Boolean);

  // جلب أولي عبر HTTP لعدد محدود حتى لا يُرفض طلب سوق فوري وقت الإقلاع
  for (const s of subscribedSymbols.slice(0, 20)) {
    try { await fetchPriceHTTP(s); } catch {}
  }

  // افتح سوكيت مُجمَّع
  if (subscribedSymbols.length) {
    await openCombinedSocket(subscribedSymbols);
  }
}

function getCurrentPrice(symbol) {
  return priceMap.get((symbol || '').toUpperCase()) || 0;
}

async function ensureCurrentPrice(symbol) {
  const s = (symbol || '').toUpperCase();
  const cached = priceMap.get(s);
  if (cached && cached > 0) return cached;
  const fresh = await fetchPriceHTTP(s);
  return fresh;
}

module.exports = { initFuturesPriceFeed, getCurrentPrice, ensureCurrentPrice };
