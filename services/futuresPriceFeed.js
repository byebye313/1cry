// services/futuresPriceFeed.js
const WebSocket = require('ws');
const axios = require('axios');
const { TradingPair } = require('../models/TradingPair');

const priceMap = new Map();

async function fetchPriceHTTP(symbol) {
  const url = `https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`;
  const { data } = await axios.get(url);
  const p = parseFloat(data?.price);
  if (!Number.isFinite(p) || p <= 0) throw new Error('Invalid price');
  priceMap.set(symbol, p);
  return p;
}

async function initFuturesPriceFeed() {
  const pairs = await TradingPair.find({});
  for (const pair of pairs) {
    const symbol = (pair.symbol || '').toUpperCase();

    // Initial HTTP fetch so market orders don't 400 at startup
    try { await fetchPriceHTTP(symbol); } catch {}

    const stream = `wss://stream.binance.com:9443/ws/${symbol.toLowerCase()}@ticker`;
    const ws = new WebSocket(stream);

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);
        const price = parseFloat(msg?.c);
        if (Number.isFinite(price) && price > 0) {
          priceMap.set(symbol, price);
        }
      } catch {}
    });

    ws.on('error', () => {
      setTimeout(() => fetchPriceHTTP(symbol).catch(() => {}), 3000);
    });

    ws.on('close', () => {
      setTimeout(() => initFuturesPriceFeed().catch(() => {}), 3000);
    });
  }
}

function getCurrentPrice(symbol) {
  return priceMap.get((symbol || '').toUpperCase()) || 0;
}

// Try cache; if missing, get it via HTTP now and cache it.
async function ensureCurrentPrice(symbol) {
  const s = (symbol || '').toUpperCase();
  const cached = priceMap.get(s);
  if (cached && cached > 0) return cached;
  const fresh = await fetchPriceHTTP(s);
  return fresh;
}

module.exports = { initFuturesPriceFeed, getCurrentPrice, ensureCurrentPrice };
