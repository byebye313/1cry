// controllers/futuresTradeController.js

const { FutureTrade, validateFutureTrade } = require('../models/FutureTrade');
const { FuturesWallet } = require('../models/FutureWallet');
const { FuturesWalletBalance } = require('../models/FutureWalletBalance');
const { FuturesTradeHistory } = require('../models/FutureTradeHistory');
const { TradingPair } = require('../models/TradingPair');
const { Asset } = require('../models/Asset');
const { Notification } = require('../models/Notification');

const {
  getCurrentPrice,
  ensureCurrentPrice,
  watchSymbolForTrade,
  unwatchSymbolForTrade,
} = require('../services/futuresPriceFeed');

const { closeTrade } = require('../services/futuresEngine');

// Helpers
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

// POST /api/futures/trade
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
if (!wallet) {
  return res.status(400).json({
    message: 'Futures wallet not found. Please initialize your futures wallet first.'
  });
}

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

      bal.balance -= IM;
      await bal.save();

      const liq = E * (position === 'Long' ? (1 - 1 / leverage) : (1 + 1 / leverage));

      trade.status = 'Filled';
      trade.open_price = E;
      trade.executed_at = new Date();
      trade.liquidation_price = liq;
      await trade.save();

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

      try {
        await Notification.create({
          user_id,
          type: 'FuturesTrade',
          title: 'Market Order Executed',
          message: `Opened ${position} at ${E}`,
          is_read: false,
        });
      } catch {}

      // ابدأ مراقبة هذا الزوج
      watchSymbolForTrade(symbol);

      req.io?.to(String(user_id)).emit('futures_order_status_update', {
        trade_id: trade._id.toString(),
        status: 'Filled',
        symbol,
        open_price: E,
        liquidation_price: liq,
      });

      return res.json({ trade });
    }

    // Limit — يبقى Pending (دون WS)
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

// POST /api/futures/close/:trade_id
async function closeFutureTrade(req, res) {
  const trade = await FutureTrade.findById(req.params.trade_id).populate('trading_pair_id');
  if (!trade) return res.status(404).json({ message: 'Trade not found' });
  if (!trade.trading_pair_id) return res.status(400).json({ message: 'Pair not found' });
  if (trade.status !== 'Filled') return res.status(400).json({ message: 'Trade not open' });

  const symbol = String(trade.trading_pair_id.symbol || '').toUpperCase();
  const price = getCurrentPrice(symbol) || (await ensureCurrentPrice(symbol));
  if (!price || price <= 0) return res.status(400).json({ message: 'Price unavailable' });

  const result = await closeTrade(trade, 'Manual Close', price);

  req.io?.to(String(trade.user_id)).emit('futures_order_status_update', {
    trade_id: trade._id.toString(),
    status: 'Closed',
    symbol,
    close_price: result?.close_price,
    pnl: result?.pnl,
  });

  return res.json({
    ok: true,
    symbol,
    close_price: result?.close_price,
    pnl: result?.pnl,
  });
}

// POST /api/futures/cancel/:trade_id
async function cancelFutureTrade(req, res) {
  const trade = await FutureTrade.findById(req.params.trade_id).populate('trading_pair_id');
  if (!trade) return res.status(404).json({ message: 'Trade not found' });

  if (!(trade.status === 'Pending' && trade.order_type === 'Limit')) {
    return res.status(400).json({ message: 'Only pending limit orders can be canceled' });
  }

  const symbol = String(trade?.trading_pair_id?.symbol || '').toUpperCase();

  await FuturesTradeHistory.create({
    future_trade_id: trade._id,
    user_id: trade.user_id,
    trading_pair_id: trade.trading_pair_id,
    trading_pair_symbol: symbol,
    position: trade.position,
    leverage: trade.leverage,
    margin_type: trade.margin_type,
    amount: trade.amount,
    open_price: trade.open_price || null,
    close_price: null,
    pnl: 0,
    status: 'Cancelled',
    executed_at: new Date(),
    created_at: new Date(),
  });

  await FutureTrade.deleteOne({ _id: trade._id });

  req.io?.to(String(trade.user_id)).emit('futures_order_status_update', {
    trade_id: trade._id.toString(),
    status: 'Cancelled',
  });

  return res.json({ ok: true });
}

// GET /api/futures/history/:user_id
async function getFutureTradeHistory(req, res) {
  const items = await FuturesTradeHistory.find({ user_id: req.params.user_id })
    .sort({ executed_at: -1 })
    .limit(500);
  return res.json({ history: items });
}

// GET /api/futures/open/:user_id
async function getOpenFutureTrades(req, res) {
  const open = await FutureTrade.find({ user_id: req.params.user_id, status: 'Filled' })
    .populate({ path: 'trading_pair_id', select: 'symbol' })
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
