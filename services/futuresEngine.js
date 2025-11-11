// services/futuresEngine.js
const { FutureTrade } = require('../models/FutureTrade');
const { FuturesTradeHistory } = require('../models/FutureTradeHistory');
const { FuturesWalletBalance } = require('../models/FutureWalletBalance');
const { Asset } = require('../models/Asset');
const { Notification } = require('../models/Notification');
const { getCurrentPrice } = require('./futuresPriceFeed');

// — نفس الدالة الآمنة —
function calcLiquidationSafe({ side, qty, entryPrice, baseEquity, leverage, mmr = 0.004, feesBuffer = 0 }) {
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

let ioRef = null;
function bindIo(io) { ioRef = io; }
function emitToUser(userId, payload) { if (ioRef) ioRef.to(String(userId)).emit('futures_order_status_update', payload); }

async function getUSDT() {
  const usdt = await Asset.findOne({ symbol: 'USDT' }).lean();
  if (!usdt) throw new Error('USDT asset not found');
  return usdt;
}
async function getWalletUSDTBalance(futures_wallet_id) {
  const usdt = await getUSDT();
  let bal = await FuturesWalletBalance.findOne({ futures_wallet_id, asset_id: usdt._id });
  if (!bal) bal = await FuturesWalletBalance.create({ futures_wallet_id, asset_id: usdt._id, balance: 0 });
  return bal;
}

async function executeLimitIfHit(order, currentPrice) {
  const hit =
    (order.position === 'Long'  && currentPrice <= order.limit_price) ||
    (order.position === 'Short' && currentPrice >= order.limit_price);
  if (!hit) return false;

  const q = order.amount;
  const E = currentPrice;
  const notional = E * q;
  const IM = notional / order.leverage;
  const walletBal = await getWalletUSDTBalance(order.futures_wallet_id);

  let baseEquity;
  if (order.margin_type === 'Isolated') {
    if (walletBal.balance < IM) throw new Error('Insufficient isolated margin');
    walletBal.balance -= IM;
    await walletBal.save();
    baseEquity = IM;
  } else {
    if (walletBal.balance < IM) throw new Error('Insufficient cross margin');
    walletBal.balance -= IM;
    await walletBal.save();
    baseEquity = IM + walletBal.balance; // cross buffer
  }

  const liq = calcLiquidationSafe({
    side: order.position,
    qty: q,
    entryPrice: E,
    baseEquity,
    leverage: order.leverage,
    feesBuffer: notional * 0.0005,
  });

  order.status = 'Filled';
  order.open_price = E;
  order.executed_at = new Date();
  order.liquidation_price = liq;
  await order.save();

  await FuturesTradeHistory.create({
    future_trade_id: order._id,
    user_id: order.user_id,
    trading_pair_id: order.trading_pair_id,
    trading_pair_symbol: order.trading_pair_symbol, // نستخدم الحقل المباشر إن كان موجودًا
    position: order.position,
    leverage: order.leverage,
    amount: q,
    open_price: E,
    status: 'Filled',
    executed_at: new Date(),
  });

  try {
    await Notification.create({
      user_id: order.user_id,
      type: 'FuturesTrade',
      title: 'Limit Order Executed',
      message: `Your ${order.position} limit order was filled at ${E}.`,
      is_read: false,
    });
  } catch {}

  emitToUser(order.user_id, {
    trade_id: order._id.toString(),
    status: 'Filled',
    symbol: order.trading_pair_symbol,
    open_price: E,
    liquidation_price: liq,
  });

  return true;
}

async function closeTrade(trade, reason, closePrice) {
  const q = trade.amount;
  const E = trade.open_price;
  const pnl = (trade.position === 'Long') ? (closePrice - E) * q : (E - closePrice) * q;

  const walletBal = await getWalletUSDTBalance(trade.futures_wallet_id);
  const IM = (E * q) / trade.leverage;

  walletBal.balance += (IM + pnl);
  await walletBal.save();

  trade.status = (reason === 'Liquidation') ? 'Liquidated' : 'Closed';
  trade.close_price = closePrice;
  trade.closed_at = new Date();
  trade.pnl = pnl;
  await trade.save();

  await FuturesTradeHistory.create({
    future_trade_id: trade._id,
    user_id: trade.user_id,
    trading_pair_id: trade.trading_pair_id,
    trading_pair_symbol: trade.trading_pair_symbol,
    position: trade.position,
    leverage: trade.leverage,
    amount: q,
    open_price: E,
    close_price: closePrice,
    pnl,
    status: reason,
    executed_at: new Date(),
  });

  try {
    await Notification.create({
      user_id: trade.user_id,
      type: 'FuturesTrade',
      title: reason === 'Liquidation' ? 'Position Liquidated' : 'Position Closed',
      message: `Your ${trade.position} position was ${reason.toLowerCase()} at ${closePrice}. PnL: ${pnl.toFixed(2)} USDT`,
      is_read: false,
    });
  } catch {}

  emitToUser(trade.user_id, {
    trade_id: trade._id.toString(),
    status: (reason === 'Liquidation') ? 'Liquidated' : 'Closed',
    symbol: trade.trading_pair_symbol,
    close_price: closePrice,
    pnl,
  });
}

// ——— مسح مُجزّأ وخفيف ——— //
async function scanLimitOrders(batchSize = 500) {
  let lastId = null;
  // نختار حقولًا نحتاجها فقط + lean لتقليل الذاكرة
  const baseQuery = { status: 'Pending', order_type: 'Limit' };
  while (true) {
    const chunk = await FutureTrade.find(
      lastId ? { ...baseQuery, _id: { $gt: lastId } } : baseQuery,
      {
        _id: 1, user_id: 1, trading_pair_symbol: 1, trading_pair_id: 1,
        position: 1, leverage: 1, amount: 1, limit_price: 1,
        margin_type: 1, futures_wallet_id: 1,
      }
    )
      .sort({ _id: 1 })
      .limit(batchSize)
      .lean();

    if (!chunk.length) break;

    for (const ord of chunk) {
      const price = getCurrentPrice(ord.trading_pair_symbol || ord.trading_pair_id?.symbol);
      if (!price) continue;
      try {
        // نعيد تحميل الوثيقة كاملة عند التنفيذ فقط (تقليل IO/Memory)
        const doc = await FutureTrade.findById(ord._id);
        if (doc) await executeLimitIfHit(doc, price);
      } catch {/* log */}
    }
    lastId = chunk[chunk.length - 1]._id;
  }
}

async function scanOpenTrades(batchSize = 500) {
  let lastId = null;
  const baseQuery = { status: 'Filled' };
  while (true) {
    const chunk = await FutureTrade.find(
      lastId ? { ...baseQuery, _id: { $gt: lastId } } : baseQuery,
      {
        _id: 1, user_id: 1, trading_pair_symbol: 1, trading_pair_id: 1,
        position: 1, leverage: 1, amount: 1, open_price: 1,
        liquidation_price: 1, take_profit_price: 1, stop_loss_price: 1,
        futures_wallet_id: 1,
      }
    )
      .sort({ _id: 1 })
      .limit(batchSize)
      .lean();

    if (!chunk.length) break;

    for (const t of chunk) {
      const symbol = t.trading_pair_symbol || t.trading_pair_id?.symbol;
      const price = getCurrentPrice(symbol);
      if (!price) continue;

      let shouldClose = false;
      let reason = 'Manual Close';

      if ((t.position === 'Long' && price <= t.liquidation_price) ||
          (t.position === 'Short' && price >= t.liquidation_price)) {
        shouldClose = true; reason = 'Liquidation';
      }
      if (!shouldClose && t.take_profit_price) {
        if ((t.position === 'Long' && price >= t.take_profit_price) ||
            (t.position === 'Short' && price <= t.take_profit_price)) {
          shouldClose = true; reason = 'Take Profit';
        }
      }
      if (!shouldClose && t.stop_loss_price) {
        if ((t.position === 'Long' && price <= t.stop_loss_price) ||
            (t.position === 'Short' && price >= t.stop_loss_price)) {
          shouldClose = true; reason = 'Stop Loss';
        }
      }

      if (shouldClose) {
        try {
          // نعيد تحميل الوثيقة كاملة فقط لحظة الإغلاق
          const doc = await FutureTrade.findById(t._id);
          if (doc) await closeTrade(doc, reason, price);
        } catch {/* log */}
      }
    }
    lastId = chunk[chunk.length - 1]._id;
  }
}

let engineTimer = null;
function initFuturesEngine(io) {
  bindIo(io);
  if (engineTimer) clearInterval(engineTimer);
  // 3 ثواني كافية، ويمكن رفعها إلى 5–10 ثواني حسب الحمل
  engineTimer = setInterval(async () => {
    try {
      await scanLimitOrders(400);  // دفعات أصغر = ذواكر أقل
      await scanOpenTrades(400);
    } catch {/* log */}
  }, 3000);
}

module.exports = { initFuturesEngine, closeTrade };
