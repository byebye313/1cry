// services/futuresPriceFeed.js
const WebSocket = require('ws');
const axios = require('axios');
const { TradingPair } = require('../models/TradingPair');

const priceMap = new Map();

const BINANCE_WS = 'wss://stream.binance.com:9443/stream';
const HTTP_PRICE = (sym) => `https://api.binance.com/api/v3/ticker/price?symbol=${sym}`;
const RECONNECT_BASE_MS = 1500;
const MAX_STREAMS_PER_SOCKET = 200; // Split symbols to avoid very long urls
const HEARTBEAT_MS = 15000;

let sockets = []; // [{ ws, symbols, hbTimer, reconnectAttempts }]
let subscribedSymbols = [];

async function fetchPriceHTTP(symbol) {
  const { data } = await axios.get(HTTP_PRICE(symbol), { timeout: 8000 });
  const p = parseFloat(data?.price);
  if (!Number.isFinite(p) || p <= 0) throw new Error('Invalid price');
  priceMap.set(symbol, p);
  return p;
}

function buildCombinedUrl(symbols) {
  const streams = symbols.map((s) => `${s.toLowerCase()}@ticker`).join('/');
  return `${BINANCE_WS}?streams=${streams}`;
}

function cleanupSocket(entry) {
  try { entry.ws?.removeAllListeners?.(); } catch {}
  try { clearInterval(entry.hbTimer); } catch {}
  try { entry.ws?.close?.(); } catch {}
  entry.ws = null;
}

function openSocketGroup(symbols, idx) {
  const url = buildCombinedUrl(symbols);
  const entry = { ws: null, symbols, hbTimer: null, reconnectAttempts: 0 };

  const connect = () => {
    cleanupSocket(entry);
    entry.ws = new WebSocket(url);

    entry.ws.on('open', () => {
      entry.reconnectAttempts = 0;
      // Heartbeat
      entry.hbTimer = setInterval(() => {
        try { entry.ws?.ping?.(); } catch {}
      }, HEARTBEAT_MS);
    });

    entry.ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);
        const data = msg?.data || msg; // combined stream => { stream, data }
        const symbol = (data?.s || '').toUpperCase();
        const price = parseFloat(data?.c);
        if (symbol && Number.isFinite(price) && price > 0) {
          priceMap.set(symbol, price);
        }
      } catch { /* ignore */ }
    });

    entry.ws.on('error', () => {
      // Try to refresh a few symbols via HTTP so engine isn't blind
      symbols.slice(0, 5).forEach((s) => fetchPriceHTTP(s).catch(() => {}));
    });

    entry.ws.on('close', () => {
      cleanupSocket(entry);
      const backoff = Math.min(RECONNECT_BASE_MS * Math.pow(2, entry.reconnectAttempts++), 15000);
      setTimeout(connect, backoff);
    });
  };

  connect();
  sockets[idx] = entry;
}

async function initFuturesPriceFeed() {
  // Load symbols once
  const pairs = await TradingPair.find({}, { symbol: 1, _id: 0 }).lean();
  subscribedSymbols = (pairs || [])
    .map((p) => (p.symbol || '').toUpperCase())
    .filter(Boolean);

  // Prefetch a few to warm cache at boot
  for (const s of subscribedSymbols.slice(0, 20)) {
    try { await fetchPriceHTTP(s); } catch {}
  }

  // Split into groups to respect URL length and reliability
  sockets.forEach(cleanupSocket);
  sockets = [];

  for (let i = 0; i < subscribedSymbols.length; i += MAX_STREAMS_PER_SOCKET) {
    const chunk = subscribedSymbols.slice(i, i + MAX_STREAMS_PER_SOCKET);
    openSocketGroup(chunk, sockets.length);
  }
}

function getCurrentPrice(symbol) {
  return priceMap.get((symbol || '').toUpperCase()) || 0;
}

// Try cache first; if missing, get via HTTP now and cache it.
async function ensureCurrentPrice(symbol) {
  const s = (symbol || '').toUpperCase();
  const cached = priceMap.get(s);
  if (cached && cached > 0) return cached;
  const fresh = await fetchPriceHTTP(s);
  return fresh;
}

module.exports = { initFuturesPriceFeed, getCurrentPrice, ensureCurrentPrice };
