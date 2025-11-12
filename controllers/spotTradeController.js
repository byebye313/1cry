// controllers/spotTradeController.js
const mongoose = require('mongoose');
const { SpotTrade, validateSpotTrade } = require('../models/SpotTrade');
const { OrderBook, validateOrderBook } = require('../models/OrderBook');
const { SpotWalletBalance } = require('../models/SpotWalletBalance');
const { TradingPair } = require('../models/TradingPair');
const { SpotWallet } = require('../models/SpotWallet');
const { Notification } = require('../models/Notification');
const { Referral } = require('../models/Refferal');

const {
  getCurrentPrice,
  ensureCurrentPrice,
  addSpotSymbol,
  removeSpotSymbol,
} = require('../services/binanceServices');

async function createSpotTrade(req, res) {
  const { error } = validateSpotTrade(req.body);
  if (error) return res.status(400).send(error.details[0].message);

  const { trading_pair_id, trade_type, order_type, limit_price, amount } = req.body;
  const user_id = req.user?.id;
  if (!user_id) return res.status(401).send('Please log in first.');

  let userIdAsObjectId;
  try { userIdAsObjectId = new mongoose.Types.ObjectId(user_id); }
  catch { return res.status(400).send('Invalid user ID.'); }

  let spotWallet = await SpotWallet.findOne({ user_id: userIdAsObjectId });
  if (!spotWallet) {
    spotWallet = new SpotWallet({ user_id: userIdAsObjectId });
    await spotWallet.save();
  }
  const spot_wallet_id = spotWallet._id;

  const tradingPair = await TradingPair.findById(trading_pair_id);
  if (!tradingPair) return res.status(404).send('Trading pair not found.');

  let currentPrice = getCurrentPrice(tradingPair.symbol);
  if (order_type === 'Market' && (!currentPrice || currentPrice === 0)) {
    try {
      currentPrice = await ensureCurrentPrice(tradingPair.symbol);
    } catch {
      return res.status(400).send('Current market price is unavailable. Please try again later.');
    }
  }

  const baseAssetBalance = await SpotWalletBalance.findOne({
    spot_wallet_id,
    asset_id: tradingPair.base_asset_id,
  });
  const quoteAssetBalance = await SpotWalletBalance.findOne({
    spot_wallet_id,
    asset_id: tradingPair.quote_asset_id,
  });

  const price = order_type === 'Limit' ? limit_price : currentPrice;
  const totalCost = price * amount;

  if (trade_type === 'Sell') {
    if (!baseAssetBalance || baseAssetBalance.balance < amount) {
      return res.status(400).send(`Insufficient balance for base asset.`);
    }
  } else if (trade_type === 'Buy') {
    if (!quoteAssetBalance || quoteAssetBalance.balance < totalCost) {
      return res.status(400).send(`Insufficient balance for quote asset.`);
    }
  }

  const trade = new SpotTrade({
    user_id,
    spot_wallet_id,
    trading_pair_id,
    trade_type,
    order_type,
    limit_price: order_type === 'Limit' ? limit_price : undefined,
    amount,
  });

  try {
    if (order_type === 'Market') {
      trade.executed_price = currentPrice;
      trade.total_cost = totalCost;
      trade.status = 'Filled';

      if (trade_type === 'Buy') {
        quoteAssetBalance.balance -= totalCost;
        baseAssetBalance.balance = (baseAssetBalance.balance || 0) + amount;
      } else {
        baseAssetBalance.balance -= amount;
        quoteAssetBalance.balance = (quoteAssetBalance.balance || 0) + totalCost;
      }

      await Promise.all([
        quoteAssetBalance.save(),
        baseAssetBalance.save(),
        trade.save(),
      ]);

      // Referral logic
      const referral = await Referral.findOne({ referred_user_id: user_id, status: 'Pending' });
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

      await new Notification({
        user_id: userIdAsObjectId,
        type: 'SpotTrade',
        title: `Market ${trade_type === 'Buy' ? 'Buy' : 'Sell'} Executed`,
        message: `${trade_type === 'Buy' ? 'Buy' : 'Sell'} ${tradingPair.symbol} at ${currentPrice}, amount ${amount}.`,
        is_read: false,
      }).save();

      return res.status(201).send(trade);
    } else {
      // Limit: create OrderBook + أضف الرمز للنشط ليبدأ Poller
      const orderData = {
        trading_pair_id,
        trade_id: trade._id.toString(),
        trade_type,
        order_type: 'Spot',
        price: limit_price,
        amount,
      };

      const { error: orderError } = require('../models/OrderBook').validateOrderBook(orderData);
      if (orderError) return res.status(400).send(orderError.details[0].message);

      const order = new (require('../models/OrderBook').OrderBook)(orderData);

      await order.save();
      await trade.save();

      // أبلغ الـPoller أن هذا الرمز لديه أوامر معلّقة
      addSpotSymbol(tradingPair.symbol);

      await new Notification({
        user_id: userIdAsObjectId,
        type: 'SpotTrade',
        title: `Limit ${trade_type === 'Buy' ? 'Buy' : 'Sell'} Placed`,
        message: `Limit ${trade_type === 'Buy' ? 'Buy' : 'Sell'} for ${tradingPair.symbol} at ${limit_price}, amount ${amount}.`,
        is_read: false,
      }).save();

      return res.status(201).send(trade);
    }
  } catch (err) {
    return res.status(500).send(`Error processing the trade: ${err.message}`);
  }
}

async function cancelSpotTrade(req, res) {
  const { trade_id } = req.params;
  const trade = await SpotTrade.findById(trade_id);
  if (!trade) return res.status(404).send('Trade not found.');
  if (trade.status !== 'Pending') return res.status(400).send('Only pending trades can be cancelled.');

  try {
    const OrderBookModel = require('../models/OrderBook').OrderBook;
    const order = await OrderBookModel.findOne({ trade_id: trade._id.toString(), status: 'Pending' });

    trade.status = 'Cancelled';
    if (order) order.status = 'Cancelled';

    await trade.save();
    if (order) await order.save();

    // بعد الإلغاء: إن لم يعد هناك أوامر معلّقة لهذا الرمز — أزله من مجموعة النشط
    const pair = await TradingPair.findById(trade.trading_pair_id).select('symbol');
    if (pair?.symbol) {
      const anyPending = await OrderBookModel.exists({
        trading_pair_id: trade.trading_pair_id,
        order_type: 'Spot',
        status: 'Pending',
      });
      if (!anyPending) removeSpotSymbol(pair.symbol);
    }

    const tradingPair = await TradingPair.findById(trade.trading_pair_id);
    await new Notification({
      user_id: trade.user_id,
      type: 'SpotTrade',
      title: 'Limit Order Cancelled',
      message: `Your ${trade.trade_type} limit order for ${tradingPair.symbol} (amount: ${trade.amount}) has been cancelled.`,
      is_read: false,
    }).save();

    res.status(200).send(trade);
  } catch (err) {
    return res.status(500).send(`Error cancelling the trade: ${err.message}`);
  }
}

async function getTradeHistory(req, res) {
  const { user_id } = req.params;
  try {
    const history = await SpotTrade.find({ user_id, status: 'Filled' }).populate('trading_pair_id');
    res.status(200).send(history);
  } catch (err) {
    return res.status(500).send(`Error retrieving trade history: ${err.message}`);
  }
}

async function getOpenOrders(req, res) {
  const { user_id } = req.params;
  try {
    const trades = await SpotTrade.find({ user_id, status: 'Pending' }).populate('trading_pair_id');
    res.status(200).send(trades);
  } catch (err) {
    return res.status(500).send(`Error retrieving open orders: ${err.message}`);
  }
}

module.exports = {
  createSpotTrade,
  cancelSpotTrade,
  getTradeHistory,
  getOpenOrders,
};
