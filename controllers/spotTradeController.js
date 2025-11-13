// controllers/spotTradeController.js
const mongoose = require('mongoose');
const { SpotTrade, validateSpotTrade } = require('./models/SpotTrade');
const { OrderBook, validateOrderBook } = require('./models/OrderBook');
const { SpotWalletBalance } = require('./models/SpotWalletBalance');
const { TradingPair } = require('./models/TradingPair');
const { SpotWallet } = require('./models/SpotWallet');
const { Notification } = require('./models/Notification');
const { Referral } = require('./models/Refferal');

const {
  getCurrentPrice,
  ensureCurrentPrice,
  watchSymbolForSpotOrder,
  unwatchSymbolForSpotOrder,
} = require('./services/binanceServices');

const axios = require('axios');

async function createSpotTrade(req, res) {
  const { error } = validateSpotTrade(req.body);
  if (error) return res.status(400).send(error.details[0].message);

  const { trading_pair_id, trade_type, order_type, limit_price, amount } = req.body;
  const user_id = req.user?.id;
  if (!user_id) return res.status(401).send('Please log in first.');

  let userIdAsObjectId;
  try {
    userIdAsObjectId = new mongoose.Types.ObjectId(user_id);
  } catch {
    return res.status(400).send('Invalid user ID.');
  }

  // 👇 تعديل 1: لا يتم إنشاء محفظة تلقائياً إذا لم توجد
  const spotWallet = await SpotWallet.findOne({ user_id: userIdAsObjectId });
  if (!spotWallet) {
    return res
      .status(400)
      .send('Spot wallet not found. Please initialize your spot wallet first.');
  }
  const spot_wallet_id = spotWallet._id;

  const tradingPair = await TradingPair.findById(trading_pair_id);
  if (!tradingPair) return res.status(404).send('Trading pair not found.');

  let currentPrice = getCurrentPrice(tradingPair.symbol);
  if (order_type === 'Market' && (!currentPrice || currentPrice === 0)) {
    try {
      currentPrice = await ensureCurrentPrice(tradingPair.symbol);
    } catch {
      return res
        .status(400)
        .send('Current market price is unavailable. Please try again later.');
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
      return res.status(400).send('Insufficient balance for base asset.');
    }
  } else if (trade_type === 'Buy') {
    if (!quoteAssetBalance || quoteAssetBalance.balance < totalCost) {
      return res.status(400).send('Insufficient balance for quote asset.');
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
      // === MARKET ===
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

      await Promise.all([quoteAssetBalance.save(), baseAssetBalance.save(), trade.save()]);

      // Referral logic
      const referral = await Referral.findOne({
        referred_user_id: user_id,
        status: 'Pending',
      });
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
      // === LIMIT ===
      // 👇 تعديل 2: حجز الرصيد عند إنشاء Limit Order

      if (trade_type === 'Buy') {
        // حجز USDT = limit_price * amount
        if (!quoteAssetBalance || quoteAssetBalance.balance < totalCost) {
          return res.status(400).send('Insufficient balance for quote asset.');
        }
        quoteAssetBalance.balance -= totalCost;
        await quoteAssetBalance.save();
      } else if (trade_type === 'Sell') {
        // حجز كمية الأصل الأساسي
        if (!baseAssetBalance || baseAssetBalance.balance < amount) {
          return res.status(400).send('Insufficient balance for base asset.');
        }
        baseAssetBalance.balance -= amount;
        await baseAssetBalance.save();
      }

      // إنشاء OrderBook + بدء مراقبة السعر
      const orderData = {
        trading_pair_id,
        trade_id: trade._id.toString(),
        trade_type,
        order_type: 'Spot',
        price: limit_price,
        amount,
      };

      const { error: orderError } = require('./models/OrderBook').validateOrderBook(orderData);
      if (orderError) return res.status(400).send(orderError.details[0].message);

      const order = new (require('./models/OrderBook').OrderBook)(orderData);

      await order.save();
      await trade.save();

      // start dynamic WS for this symbol keyed by this order id
      watchSymbolForSpotOrder(tradingPair.symbol, order._id);

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
  if (trade.status !== 'Pending') {
    return res.status(400).send('Only pending trades can be cancelled.');
  }

  try {
    const OrderBookModel = require('./models/OrderBook').OrderBook;
    const order = await OrderBookModel.findOne({
      trade_id: trade._id.toString(),
      status: 'Pending',
    });

    trade.status = 'Cancelled';
    if (order) order.status = 'Cancelled';

    // 👇 تعديل 3: إعادة الرصيد المحجوز عند الإلغاء
    const tradingPair = await TradingPair.findById(trade.trading_pair_id);

    if (trade.order_type === 'Limit' && tradingPair) {
      const spot_wallet_id = trade.spot_wallet_id;

      const baseAssetBalance = await SpotWalletBalance.findOne({
        spot_wallet_id,
        asset_id: tradingPair.base_asset_id,
      });
      const quoteAssetBalance = await SpotWalletBalance.findOne({
        spot_wallet_id,
        asset_id: tradingPair.quote_asset_id,
      });

      if (trade.trade_type === 'Buy') {
        const lockedCost = (trade.limit_price || 0) * trade.amount;
        if (quoteAssetBalance) {
          quoteAssetBalance.balance = (quoteAssetBalance.balance || 0) + lockedCost;
          await quoteAssetBalance.save();
        }
      } else if (trade.trade_type === 'Sell') {
        if (baseAssetBalance) {
          baseAssetBalance.balance = (baseAssetBalance.balance || 0) + trade.amount;
          await baseAssetBalance.save();
        }
      }
    }

    await trade.save();
    if (order) await order.save();

    // release dynamic watch if any
    if (order && tradingPair?.symbol) {
      unwatchSymbolForSpotOrder(tradingPair.symbol, order._id);
    }

    const tradingPairForMsg = tradingPair || (await TradingPair.findById(trade.trading_pair_id));

    await new Notification({
      user_id: trade.user_id,
      type: 'SpotTrade',
      title: 'Limit Order Cancelled',
      message: `Your ${trade.trade_type} limit order for ${
        tradingPairForMsg.symbol
      } (amount: ${trade.amount}) has been cancelled.`,
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
    const history = await SpotTrade.find({ user_id, status: 'Filled' }).populate(
      'trading_pair_id',
    );
    res.status(200).send(history);
  } catch (err) {
    return res.status(500).send(`Error retrieving trade history: ${err.message}`);
  }
}

async function getOpenOrders(req, res) {
  const { user_id } = req.params;
  try {
    const trades = await SpotTrade.find({ user_id, status: 'Pending' }).populate(
      'trading_pair_id',
    );
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
