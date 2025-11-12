// services/futuresEngine.js
// Engine scans only OPEN trades; on close -> write history then DELETE FutureTrade.

const { FutureTrade } = require('../models/FutureTrade');
const { FuturesWallet } = require('../models/FutureWallet');
const { FuturesWalletBalance } = require('../models/FutureWalletBalance');
const { FuturesTradeHistory } = require('../models/FutureTradeHistory');
const { Asset } = require('../models/Asset');
const { Notification } = require('../models/Notification');

const {
  getCurrentPrice,
  ensureCurrentPrice,
  watchSymbolForTrade,
  unwatchSymbolForTrade,
} = require('./futuresPriceFeed');

function _norm(s) { return String(s || '').trim().toUpperCase(); }

async function _ensureUSDTBalance(futures_wallet_id) {
  const usdt = await Asset.findOne({ symbol: 'USDT' });
  if (!usdt) throw new Error('USDT asset missing');
  let bal = await FuturesWalletBalance.findOne({ futures_wallet_id, asset_id: usdt._id });
  if (!bal) bal = await FuturesWalletBalance.create({ futures_wallet_id, asset_id: usdt._id, balance: 0 });
  return bal;
}

/**
 * closeTrade(trade, reason, price)
 * - يحسب pnl
 * - يعيد الهامش + يضيف/يخصم pnl إلى رصيد USDT
 * - يكتب FutureTradeHistory بالسبب
 * - يحذف FutureTrade
 * - يفك مراقبة الرمز
 */
async function closeTrade(tradeDoc, reason, priceAtClose) {
  const trade = await FutureTrade.findById(tradeDoc._id).populate('trading_pair_id');
  if (!trade || !trade.trading_pair_id) return null;

  const symbol = _norm(trade.trading_pair_id.symbol);
  let price = Number(priceAtClose);
  if (!isFinite(price) || price <= 0) {
    price = getCurrentPrice(symbol) || (await ensureCurrentPrice(symbol));
  }
  if (!isFinite(price) || price <= 0) throw new Error('Close price unavailable');

  const q = Number(trade.amount);
  const entry = Number(trade.open_price);
  const notional = entry * q;
  const pnl = trade.position === 'Long' ? (price - entry) * q : (entry - price) * q;

  const wallet = await FuturesWallet.findById(trade.futures_wallet_id);
  const bal = await _ensureUSDTBalance(wallet._id);

  const IM = notional / Math.max(1, trade.leverage);

  // ردّ الهامش + تطبيق الربح/الخسارة
  bal.balance += IM + pnl;
  await bal.save();

  // سجل الإغلاق
  await FuturesTradeHistory.create({
    future_trade_id: trade._id,
    user_id: trade.user_id,
    trading_pair_id: trade.trading_pair_id._id,
    trading_pair_symbol: symbol,
    position: trade.position,
    leverage: trade.leverage,
    margin_type: trade.margin_type,
    amount: q,
    open_price: entry,
    close_price: price,
    pnl,
    status:
      reason === 'Take Profit' ? 'Take Profit' :
      reason === 'Stop Loss'   ? 'Stop Loss'   :
      reason === 'Liquidation' ? 'Liquidation' :
      reason === 'Cancelled'   ? 'Cancelled'   :
      'Closed',
    executed_at: new Date(),
    created_at: new Date(),
  });

  try {
    await Notification.create({
      user_id: trade.user_id,
      type: 'FuturesTrade',
      title: `Futures ${reason}`,
      message: `Closed ${trade.position} ${symbol} at ${price} (PnL: ${pnl.toFixed(4)})`,
      is_read: false,
    });
  } catch {}

  // احذف الصفقة
  await FutureTrade.deleteOne({ _id: trade._id });

  // فك مراقبة الرمز (ref-count)
  unwatchSymbolForTrade(symbol);

  return { symbol, close_price: price, pnl };
}

/** تحويل Limit -> Filled عند لمس السعر */
async function fillPendingLimitIfTouched(trade, currentPrice) {
  if (trade.status !== 'Pending' || trade.order_type !== 'Limit') return false;

  const limit = Number(trade.limit_price || 0);
  const E = Number(currentPrice || 0);
  if (!(isFinite(limit) && isFinite(E) && limit > 0 && E > 0)) return false;

  const shouldFill =
    (trade.position === 'Long'  && E <= limit) ||
    (trade.position === 'Short' && E >= limit);

  if (!shouldFill) return false;

  const wallet = await FuturesWallet.findById(trade.futures_wallet_id);
  const bal = await _ensureUSDTBalance(wallet._id);

  const q = Number(trade.amount);
  const notional = E * q;
  const IM = notional / Math.max(1, trade.leverage);
  if (bal.balance < IM) return false; // هامش غير كافٍ

  bal.balance -= IM;
  await bal.save();

  trade.status = 'Filled';
  trade.open_price = E;
  trade.executed_at = new Date();
  // liquidation_price: استخدم دالتك الآمنة إن رغبت
  await trade.save();

  const symbol = _norm(trade.trading_pair_id.symbol);

  await FuturesTradeHistory.findOneAndUpdate(
    { future_trade_id: trade._id },
    {
      $set: {
        user_id: trade.user_id,
        trading_pair_id: trade.trading_pair_id._id,
        trading_pair_symbol: symbol,
        position: trade.position,
        leverage: trade.leverage,
        margin_type: trade.margin_type,
        amount: q,
        open_price: E,
        status: 'Filled',
        executed_at: new Date(),
      },
      $setOnInsert: { created_at: new Date() },
    },
    { upsert: true }
  );

  // ابدأ مراقبة الرمز (صار لدينا صفقة مفتوحة)
  watchSymbolForTrade(symbol);

  return true;
}

/** فحص أوامر الـLimit المعلّقة */
async function scanLimitOrders() {
  const pending = await FutureTrade.find({ status: 'Pending', order_type: 'Limit' })
                                  .populate('trading_pair_id')
                                  .limit(500);
  for (const t of pending) {
    const symbol = _norm(t.trading_pair_id?.symbol);
    if (!symbol) continue;
    const price = getCurrentPrice(symbol) || (await ensureCurrentPrice(symbol));
    if (!price) continue;
    await fillPendingLimitIfTouched(t, price);
  }
}

/** فحص الصفقات المفتوحة (TP/SL/Liq) */
async function scanOpenTrades() {
  const open = await FutureTrade.find({ status: 'Filled' })
                                .populate('trading_pair_id')
                                .limit(1000);
  for (const t of open) {
    const symbol = _norm(t.trading_pair_id?.symbol);
    if (!symbol) continue;
    const price = getCurrentPrice(symbol) || (await ensureCurrentPrice(symbol));
    if (!price) continue;

    const hitTP = isFinite(t.take_profit_price) && t.take_profit_price > 0 &&
      ((t.position === 'Long'  && price >= t.take_profit_price) ||
       (t.position === 'Short' && price <= t.take_profit_price));

    const hitSL = isFinite(t.stop_loss_price) && t.stop_loss_price > 0 &&
      ((t.position === 'Long'  && price <= t.stop_loss_price) ||
       (t.position === 'Short' && price >= t.stop_loss_price));

    const hitLiq = isFinite(t.liquidation_price) && t.liquidation_price > 0 &&
      ((t.position === 'Long'  && price <= t.liquidation_price) ||
       (t.position === 'Short' && price >= t.liquidation_price));

    if (hitLiq) {
      await closeTrade(t, 'Liquidation', price);
    } else if (hitTP) {
      await closeTrade(t, 'Take Profit', price);
    } else if (hitSL) {
      await closeTrade(t, 'Stop Loss', price);
    }
  }
}

function initFuturesEngine(/* io */) {
  setInterval(async () => {
    try { await scanLimitOrders(); } catch {}
    try { await scanOpenTrades(); } catch {}
  }, 2500);

  return true;
}

module.exports = {
  initFuturesEngine,
  closeTrade,
};
