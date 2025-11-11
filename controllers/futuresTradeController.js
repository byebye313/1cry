// controllers/futuresTradeController.js
const mongoose = require('mongoose');
const { FutureTrade, validateFutureTrade } = require('../models/FutureTrade');
const { FuturesWallet } = require('../models/FutureWallet');
const { FuturesWalletBalance } = require('../models/FutureWalletBalance');
const { FuturesTradeHistory } = require('../models/FutureTradeHistory');
const { TradingPair } = require('../models/TradingPair');
const { Asset } = require('../models/Asset');
const { Notification } = require('../models/Notification');
const { getCurrentPrice, ensureCurrentPrice } = require('../services/futuresPriceFeed');
const { closeTrade } = require('../services/futuresEngine');

// === Helpers ===
function getUserId(req) {
  return (
    req.user?._id ||
    req.user?.id ||
    req.user?.userId ||
    req.user?.user_id ||
    req.body?.user_id ||
    null
  );
}

async function ensureUSDTBalance(futures_wallet_id) {
  const usdt = await Asset.findOne({ symbol: 'USDT' });
  if (!usdt) throw new Error('USDT asset missing');
  let bal = await FuturesWalletBalance.findOne({ futures_wallet_id, asset_id: usdt._id });
  if (!bal) bal = await FuturesWalletBalance.create({ futures_wallet_id, asset_id: usdt._id, balance: 0 });
  return bal;
}

// Liquidation (safe fallback)
function calcLiquidationSafe({
  side, qty, entryPrice, baseEquity, leverage, mmr = 0.004, feesBuffer = 0,
}) {
  const q = Math.max(0, Number(qty));
  const E = Math.max(0, Number(entryPrice));
  const equityAdj = Math.max(0, Number(baseEquity)) - Math.max(0, Number(feesBuffer));
  if (!isFinite(q) || q <= 0 || !isFinite(E) || E <= 0 || !isFinite(leverage) || leverage <= 0) {
    return Math.max(0.01, E * (side === 'Long' ? (1 - 1 / Math.max(leverage, 1)) : (1 + 1 / Math.max(leverage, 1))));
  }
  let P;
  if (side === 'Long') {
    P = (E - equityAdj / q) / Math.max(1e-9, 1 - mmr);
    if (!isFinite(P) || P <= 0 || P >= E) P = E * (1 - 1 / leverage);
  } else {
    P = (E + equityAdj / q) / (1 + mmr);
    if (!isFinite(P) || P <= 0 || P <= E) P = E * (1 + 1 / leverage);
  }
  return Math.max(0.01, P);
}

/**
 * Pick one canonical history for a trade, update it, and delete duplicates.
 * - Prefers a history in status Filled/PartiallyFilled (the open record).
 * - Otherwise picks the oldest record.
 * - Never upserts here (no new history creation on close/cancel).
 */
async function finalizeSingleHistory(trade, { symbol, patch }) {
  const histories = await FuturesTradeHistory.find({ future_trade_id: trade._id })
    .sort({ created_at: 1, _id: 1 });

  if (!histories.length) {
    console.warn('[FuturesTradeHistory] No existing history found for trade:', trade._id.toString());
    return null;
  }

  // Prefer the open record (Filled/PartiallyFilled). Else fallback to oldest.
  let canonical =
    histories.find(h => ['Filled', 'PartiallyFilled'].includes(h.status)) ||
    histories[0];

  // Patch canonical with latest fields
  Object.assign(canonical, {
    user_id: trade.user_id,
    trading_pair_id: trade.trading_pair_id,
    trading_pair_symbol: symbol,
    position: trade.position,
    leverage: trade.leverage,
    margin_type: trade.margin_type,
    amount: trade.amount,
    open_price: trade.open_price,
    executed_at: new Date(),
    ...patch, // e.g., { status: 'Closed', close_price, pnl } OR { status: 'Cancelled' }
  });
  await canonical.save();

  // Delete all other duplicates (e.g., “Manual Close” inserted by another service)
  const toDelete = histories
    .filter(h => h._id.toString() !== canonical._id.toString())
    .map(h => h._id);
  if (toDelete.length) {
    await FuturesTradeHistory.deleteMany({ _id: { $in: toDelete } });
  }

  return canonical;
}

// === POST /api/futures/trade
async function createFutureTrade(req, res) {
  const { error, value } = validateFutureTrade(req.body);
  if (error) return res.status(400).json({ message: error.details[0].message });

  const user_id = getUserId(req);
  if (!user_id) return res.status(401).json({ message: 'Unauthorized' });

  const {
    trading_pair_id, leverage, position, margin_type,
    order_type, limit_price, amount,
    take_profit_price, stop_loss_price,
  } = value;

  try {
    const pair = await TradingPair.findById(trading_pair_id);
    if (!pair) return res.status(404).json({ message: 'Trading pair not found' });

    let wallet = await FuturesWallet.findOne({ user_id });
    if (!wallet) wallet = await FuturesWallet.create({ user_id });

    const bal = await ensureUSDTBalance(wallet._id);

    const trade = new FutureTrade({
      user_id,
      futures_wallet_id: wallet._id,
      trading_pair_id,
      leverage,
      position,
      margin_type,
      order_type,
      limit_price: order_type === 'Limit' ? limit_price : null,
      amount,
      take_profit_price: take_profit_price ?? null,
      stop_loss_price: stop_loss_price ?? null,
      status: 'Pending',
    });

    if (order_type === 'Market') {
      const symbol = String(pair.symbol || '').toUpperCase();
      let price = getCurrentPrice(symbol);
      if (!price || price <= 0) price = await ensureCurrentPrice(symbol);
      if (!price || price <= 0) return res.status(400).json({ message: 'Price not available' });

      const q = amount;
      const E = price;
      const notional = E * q;
      const IM = notional / leverage;
      if (bal.balance < IM) return res.status(400).json({ message: 'Insufficient margin' });

      // Reserve margin
      bal.balance -= IM;
      await bal.save();

      // Liquidation price
      const baseEquity = margin_type === 'Cross' ? IM + bal.balance : IM;
      const liq = calcLiquidationSafe({
        side: position, qty: q, entryPrice: E, baseEquity, leverage, mmr: 0.004, feesBuffer: notional * 0.0005,
      });

      trade.status = 'Filled';
      trade.open_price = E;
      trade.executed_at = new Date();
      trade.liquidation_price = liq;
      await trade.save();

      // Upsert the open history ONCE (create or update, keyed by future_trade_id)
      await FuturesTradeHistory.findOneAndUpdate(
        { future_trade_id: trade._id },
        {
          $set: {
            user_id,
            trading_pair_id,
            trading_pair_symbol: symbol,
            position,
            leverage,
            margin_type,
            amount: q,
            open_price: E,
            status: 'Filled',
            executed_at: new Date(),
          },
          $setOnInsert: { created_at: new Date() },
        },
        { upsert: true, new: true }
      );

      // Notification
      try {
        await Notification.create({
          user_id,
          type: 'FuturesTrade',
          title: 'Market Order Executed',
          message: `Opened ${position} at ${E}`,
          is_read: false,
        });
      } catch {}

      // Socket
      req.io?.to(String(user_id)).emit('futures_order_status_update', {
        trade_id: trade._id.toString(),
        status: 'Filled',
        symbol,
        open_price: E,
        liquidation_price: liq,
      });

      return res.json({ trade });
    }

    // Limit — stays Pending
    await trade.save();

    try {
      await Notification.create({
        user_id,
        type: 'FuturesTrade',
        title: 'Limit Order Created',
        message: `Placed ${position} limit at ${limit_price}`,
        is_read: false,
      });
    } catch {}

    return res.json({ trade });
  } catch (e) {
    return res.status(400).json({ message: e.message });
  }
}

// === POST /api/futures/close/:trade_id
async function closeFutureTrade(req, res) {
  const trade = await FutureTrade.findById(req.params.trade_id).populate('trading_pair_id');
  if (!trade) return res.status(404).json({ message: 'Trade not found' });
  if (!trade.trading_pair_id) return res.status(400).json({ message: 'Pair not found' });
  if (trade.status !== 'Filled') return res.status(400).json({ message: 'Trade not open' });

  const symbol = String(trade.trading_pair_id.symbol || '').toUpperCase();
  const price = getCurrentPrice(symbol);
  if (!price || price <= 0) return res.status(400).json({ message: 'Price unavailable' });

  // Engine may insert its own history (e.g., "Manual Close"); we'll dedupe after.
  await closeTrade(trade, 'Manual Close', price);

  const updated = await FutureTrade.findById(trade._id);

  const closePrice = updated?.close_price ?? price;
  const pnl = typeof updated?.pnl === 'number'
    ? updated.pnl
    : (trade.position === 'Long'
        ? (closePrice - trade.open_price) * trade.amount
        : (trade.open_price - closePrice) * trade.amount);

  // Ensure a single history only (no upsert); delete duplicates.
  await finalizeSingleHistory(trade, {
    symbol,
    patch: { status: 'Closed', close_price: closePrice, pnl },
  });

  req.io?.to(String(trade.user_id)).emit('futures_order_status_update', {
    trade_id: trade._id.toString(),
    status: 'Closed',
    symbol,
    close_price: closePrice,
    pnl,
  });

  return res.json({ trade: updated });
}

// === POST /api/futures/cancel/:trade_id
async function cancelFutureTrade(req, res) {
  const trade = await FutureTrade.findById(req.params.trade_id).populate('trading_pair_id');
  if (!trade) return res.status(404).json({ message: 'Trade not found' });

  if (!(trade.status === 'Pending' && trade.order_type === 'Limit')) {
    return res.status(400).json({ message: 'Only pending limit orders can be canceled' });
  }

  trade.status = 'Closed';
  trade.closed_at = new Date();
  await trade.save();

  const symbol = String(trade?.trading_pair_id?.symbol || '').toUpperCase() || undefined;

  // Update a single canonical history to Cancelled and delete others (no upsert).
  await finalizeSingleHistory(trade, {
    symbol,
    patch: { status: 'Cancelled' },
  });

  req.io?.to(String(trade.user_id)).emit('futures_order_status_update', {
    trade_id: trade._id.toString(),
    status: 'Cancelled',
  });

  return res.json({ ok: true });
}

// === GET /api/futures/history/:user_id
async function getFutureTradeHistory(req, res) {
  const items = await FuturesTradeHistory.find({ user_id: req.params.user_id })
    .sort({ executed_at: -1 })
    .limit(500);
  return res.json({ history: items });
}

// === GET /api/futures/open/:user_id
async function getOpenFutureTrades(req, res) {
  const open = await FutureTrade.find({ user_id: req.params.user_id, status: 'Filled' })
    .populate({ 
      path: 'trading_pair_id', 
      select: 'symbol'  // 👈 التعديل: ضمان تضمين 'symbol' فقط (أسرع وأكثر أمانًا)
    })
    .sort({ executed_at: -1 });
  return res.json({ trades: open });
}

module.exports = {
  createFutureTrade,
  closeFutureTrade,
  cancelFutureTrade,
  getFutureTradeHistory,
  getOpenFutureTrades,
};