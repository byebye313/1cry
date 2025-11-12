// services/binanceServices.js
// Production-grade dynamic price hub for SPOT LIMIT orders only.
// - Opens one WS per *active* symbol that has pending Spot limit orders.
// - Executes Spot limit orders on-touch.
// - Provides in-memory cache + REST fallback for on-demand price (e.g., Market).

const WebSocket = require('ws');
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
const BINANCE_WS_BASE = 'wss://stream.binance.com:9443/ws';
const BINANCE_REST_BASE = 'https://api.binance.com';
const PRICE_TTL_MS = 7000;      // cache TTL
const HEARTBEAT_MS = 25000;

// ===================== State ======================
let io;                                    // socket.io instance
const priceMap = new Map();                // symbol => { price, ts }
const sockets = new Map();                 // symbol => ws
const spotRefs = new Map();                // symbol => Set(orderId)  (ref-count by spot order)
const reconciling = { running: false };    // avoid overlapping reconciles

function _sym(s) { return String(s || '').trim().toUpperCase(); }

// ===================== Price utils =================
function getCurrentPrice(symbol) {
  const rec = priceMap.get(_sym(symbol));
  if (!rec || Date.now() - rec.ts > PRICE_TTL_MS) return 0;
  return rec.price;
}

async function ensureCurrentPrice(symbol) {
  const s = _sym(symbol);
  const cached = getCurrentPrice(s);
  if (cached > 0) return cached;

  const { data } = await axios.get(`${BINANCE_REST_BASE}/api/v3/ticker/price`, {
    params: { symbol: s },
    timeout: 3500,
  });
  const p = Number(data?.price);
  if (!isFinite(p) || p <= 0) throw new Error(`Invalid price from REST for ${s}`);
  priceMap.set(s, { price: p, ts: Date.now() });
  return p;
}

// ===================== WS management ===============
function _bindWS(symbol) {
  const s = _sym(symbol);
  if (sockets.has(s)) return;

  const ws = new WebSocket(`${BINANCE_WS_BASE}/${s.toLowerCase()}@trade`);
  let hb;

  ws.on('open', () => {
    hb = setInterval(() => { try { ws.ping(); } catch {} }, HEARTBEAT_MS);
  });

  ws.on('message', async (buf) => {
    try {
      const msg = JSON.parse(buf.toString());
      const p = Number(msg.p);
      if (!isFinite(p) || p <= 0) return;
      priceMap.set(s, { price: p, ts: Date.now() });

      // Emit price to clients (optional)
      io?.emit('price_update', { symbol: s, price: p, timestamp: new Date().toISOString() });

      // Try execute Spot limit orders for this symbol only
      await _executeSpotLimitOrdersForSymbol(s, p);
    } catch (err) {
      console.error('WS message error:', err.message);
    }
  });

  ws.on('error', (e) => {
    console.error(`WS error for ${s}:`, e.message);
    // soft fallback: try REST once (non-blocking)
    ensureCurrentPrice(s).catch(() => {});
  });

  ws.on('close', () => {
    try { clearInterval(hb); } catch {}
    sockets.delete(s);
    // If still referenced, reconnect
    if ((spotRefs.get(s)?.size || 0) > 0) {
      setTimeout(() => _bindWS(s), 1000);
    }
  });

  sockets.set(s, ws);
}

function _maybeCloseWS(symbol) {
  const s = _sym(symbol);
  const refs = spotRefs.get(s);
  if (!refs || refs.size === 0) {
    const ws = sockets.get(s);
    if (ws) {
      try { ws.close(); } catch {}
      sockets.delete(s);
    }
  }
}

// Public: acquire/release for a SPOT limit order
function watchSymbolForSpotOrder(symbol, orderId) {
  const s = _sym(symbol);
  let set = spotRefs.get(s);
  if (!set) { set = new Set(); spotRefs.set(s, set); }
  if (!set.has(String(orderId))) {
    set.add(String(orderId));
    if (set.size === 1) _bindWS(s);  // first reference: open WS
  }
}

function unwatchSymbolForSpotOrder(symbol, orderId) {
  const s = _sym(symbol);
  const set = spotRefs.get(s);
  if (!set) return;
  set.delete(String(orderId));
  if (set.size === 0) _maybeCloseWS(s);
}

// ===================== Spot execution ==============
async function _executeSpotTrade(trade, tradingPair, order, currentPrice) {
  // mirrors your previous logic but scoped for SPOT only
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

  // update balances
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

  // Referral check (unchanged)
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

  // Notify
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

  // release WS reference for this specific order
  unwatchSymbolForSpotOrder(tradingPair.symbol, order._id);
}

async function _executeSpotLimitOrdersForSymbol(symbol, currentPrice) {
  // Only pending orders for this symbol
  const pair = await TradingPair.findOne({ symbol });
  if (!pair) return;

  const pending = await OrderBook.find({
    trading_pair_id: pair._id,
    order_type: 'Spot',
    status: 'Pending',
  }).limit(500);

  for (const order of pending) {
    const trade = await SpotTrade.findById(order.trade_id);
    if (!trade) {
      // orphan order: cleanup reference (defensive)
      unwatchSymbolForSpotOrder(symbol, order._id);
      continue;
    }

    const canExecute =
      (order.trade_type === 'Buy'  && currentPrice <= order.price) ||
      (order.trade_type === 'Sell' && currentPrice >= order.price);

    if (!canExecute) continue;

    await _executeSpotTrade(trade, pair, order, currentPrice);
  }
}

// ===================== Bootstrapping =================
async function _reconcileActiveSpotSymbols() {
  if (reconciling.running) return;
  reconciling.running = true;
  try {
    // find symbols that actually have PENDING Spot orders
    const pendingOrders = await OrderBook.find({ order_type: 'Spot', status: 'Pending' })
      .select(['trading_pair_id', '_id', 'price']).limit(2000);
    if (!pendingOrders.length) return;

    const pairIds = [...new Set(pendingOrders.map(o => String(o.trading_pair_id)))];
    const pairs = await TradingPair.find({ _id: { $in: pairIds } }).select(['symbol']);
    const idToSym = new Map(pairs.map(p => [String(p._id), p.symbol]));

    // ensure a WS for each symbol with at least one pending order
    for (const order of pendingOrders) {
      const sym = idToSym.get(String(order.trading_pair_id));
      if (!sym) continue;
      watchSymbolForSpotOrder(sym, order._id); // this opens WS if first reference
    }
  } finally {
    reconciling.running = false;
  }
}

function initializeWebSockets(ioInstance) {
  io = ioInstance;
  // No global WS for all pairs. Start empty, then reconcile from DB.
  _reconcileActiveSpotSymbols().catch((e) => console.error('reconcile error:', e.message));
  // optional: periodic reconcile (e.g., every 60s) to catch orders created on other nodes
  setInterval(() => _reconcileActiveSpotSymbols().catch(() => {}), 60_000);
}

module.exports = {
  // public API
  initializeWebSockets,
  getCurrentPrice,
  ensureCurrentPrice,
  watchSymbolForSpotOrder,
  unwatchSymbolForSpotOrder,
};
