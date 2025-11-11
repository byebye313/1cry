const WebSocket = require('ws');
const mongoose = require('mongoose');
const axios = require('axios');
const { TradingPair } = require('../models/TradingPair');
const { OrderBook } = require('../models/OrderBook');
const { SpotTrade } = require('../models/SpotTrade');
const { SpotWallet } = require('../models/SpotWallet');
const { SpotWalletBalance } = require('../models/SpotWalletBalance');
const { Notification } = require('../models/Notification');
const { Referral } = require('../models/Refferal');
const { FutureTrade } = require('../models/FutureTrade');
const { FutureWalletBalance } = require('../models/FutureWalletBalance');
const { Asset } = require('../models/Asset');
const { calculateLiquidationPrice, calculatePnL } = require('./futuresCalculation');

const priceMap = new Map();
let io;

async function executeSpotTrade(trade, tradingPair, order, currentPrice) {
  try {
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

    trade.executed_price = currentPrice;
    trade.total_cost = currentPrice * order.amount;
    trade.status = 'Filled';
    order.status = 'Filled';

    const totalCost = trade.executed_price * trade.amount;

    if (trade.trade_type === 'Buy') {
      quoteAssetBalance.balance -= totalCost;
      baseAssetBalance.balance = (baseAssetBalance.balance || 0) + trade.amount;
    } else if (trade.trade_type === 'Sell') {
      baseAssetBalance.balance -= trade.amount;
      quoteAssetBalance.balance = (quoteAssetBalance.balance || 0) + totalCost;
    }

    await quoteAssetBalance.save();
    await baseAssetBalance.save();
    await trade.save();
    await order.save();

    const referral = await Referral.findOne({ referred_user_id: trade.user_id, status: 'Pending' });
    if (referral && totalCost >= 50) {
      referral.status = 'Eligible';
      referral.trade_met = true;
      referral.trade_amount = totalCost;
      await referral.save();

      const referrerNotification = new Notification({
        user_id: referral.referrer_id,
        type: 'Referral',
        title: 'Referral Status Updated',
        message: `Your referral's trade of ${totalCost} USDT has met the 50 USDT minimum. Status updated to Eligible!`,
        is_read: false,
      });
      await referrerNotification.save();
    }
    
    const notification = new Notification({
      user_id: trade.user_id,
      type: 'SpotTrade',
      title: `Limit ${trade.trade_type === 'Buy' ? 'Buy' : 'Sell'} Order Executed`,
      message: `Limit ${trade.trade_type === 'Buy' ? 'Buy' : 'Sell'} order for ${tradingPair.symbol} was executed at price ${currentPrice} for amount ${order.amount}.`,
      is_read: false,
    });
    await notification.save();

    if (io) {
      io.emit('order_status_update', {
        trade_id: trade._id.toString(),
        status: trade.status,
        symbol: tradingPair.symbol,
        executed_price: trade.executed_price,
        total_cost: trade.total_cost,
        timestamp: new Date().toISOString(),
      });
    }

  } catch (error) {
    console.error('Error executing spot trade:', error.message); // إضافة logging
    throw error;
  }
}

async function checkFutureOpenTrades(symbol, currentPrice) {
  try {
    const tradingPair = await TradingPair.findOne({ symbol });
    if (!tradingPair) return;

    const openTrades = await FutureTrade.find({
      trading_pair_id: tradingPair._id,
      status: 'Filled',
    });

    for (const trade of openTrades) {
      let closeTrade = false;
      let closingReason = '';
      
      if (trade.take_profit_price && (trade.position === 'Long' && currentPrice >= trade.take_profit_price) || (trade.position === 'Short' && currentPrice <= trade.take_profit_price)) {
        closeTrade = true;
        closingReason = 'Take Profit';
      } else if (trade.stop_loss_price && (trade.position === 'Long' && currentPrice <= trade.stop_loss_price) || (trade.position === 'Short' && currentPrice >= trade.stop_loss_price)) {
        closeTrade = true;
        closingReason = 'Stop Loss';
      }

      if ((trade.position === 'Long' && currentPrice <= trade.liquidation_price) || (trade.position === 'Short' && currentPrice >= trade.liquidation_price)) {
        closeTrade = true;
        closingReason = 'Liquidation';
      }

      if (closeTrade) {
        const pnl = calculatePnL(trade.open_price, currentPrice, trade.amount, trade.leverage, trade.position);
        const usdtAsset = await Asset.findOne({ symbol: 'USDT' });
        const futuresWalletBalance = await FutureWalletBalance.findOne({
          futures_wallet_id: trade.futures_wallet_id,
          asset_id: usdtAsset._id,
        });

        const initialMargin = (trade.amount * trade.open_price) / trade.leverage;
        const totalAmountToReturn = initialMargin + pnl;

        futuresWalletBalance.balance += totalAmountToReturn;
        await futuresWalletBalance.save();

        trade.close_price = currentPrice;
        trade.status = 'Closed'; // أو 'Liquidated' إذا كان liquidation
        if (closingReason === 'Liquidation') trade.status = 'Liquidated';
        await trade.save();

        const history = new FutureTradeHistory({
          future_trade_id: trade._id,
          user_id: trade.user_id,
          trading_pair_id: trade.trading_pair_id,
          price: currentPrice,
          amount: trade.amount,
          position: trade.position,
          executed_at: new Date(),
        });
        await history.save();

        const notification = new Notification({
          user_id: trade.user_id,
          type: 'FuturesTrade',
          title: `${closingReason} Triggered`,
          message: `Your ${trade.position} trade for ${tradingPair.symbol} was closed due to ${closingReason} at ${currentPrice}. PnL: ${pnl.toFixed(2)} USDT.`,
          is_read: false,
        });
        await notification.save();
      }
    }
  } catch (error) {
    console.error('Error checking future open trades:', error.message); // إضافة logging
  }
}

async function checkLimitOrders(symbol, currentPrice) {
  try {
    const tradingPair = await TradingPair.findOne({ symbol });
    if (!tradingPair) return;

    const orders = await OrderBook.find({
      trading_pair_id: tradingPair._id,
      status: 'Pending',
    });

    for (const order of orders) {
      if (order.order_type === 'Spot') {
        const trade = await SpotTrade.findOne({ _id: new mongoose.Types.ObjectId(order.trade_id) });
        if (!trade) continue;

        if ((order.trade_type === 'Buy' && currentPrice <= order.price) || (order.trade_type === 'Sell' && currentPrice >= order.price)) {
          await executeSpotTrade(trade, tradingPair, order, currentPrice);
        }
      } else if (order.order_type === 'Futures') {
        const trade = await FutureTrade.findOne({ _id: new mongoose.Types.ObjectId(order.trade_id) });
        if (!trade) continue;
        
        if ((order.trade_type === 'Buy' && currentPrice <= order.price) || (order.trade_type === 'Sell' && currentPrice >= order.price)) {
          const usdtAsset = await Asset.findOne({ symbol: 'USDT' });
          const futuresWalletBalance = await FutureWalletBalance.findOne({
            futures_wallet_id: trade.futures_wallet_id,
            asset_id: usdtAsset._id,
          });
          
          const initialMargin = (order.amount * order.price) / trade.leverage;
          const liquidationPrice = calculateLiquidationPrice(order.price, trade.leverage, trade.position, trade.margin_type, initialMargin);
          
          trade.status = 'Filled';
          trade.open_price = order.price;
          trade.liquidation_price = liquidationPrice;
          await trade.save();
          
          order.status = 'Filled';
          await order.save();
          
          const notification = new Notification({
            user_id: trade.user_id,
            type: 'FuturesTrade',
            title: 'Limit Order Executed',
            message: `Your ${trade.position} limit order for ${tradingPair.symbol} was executed at price ${order.price}.`,
            is_read: false,
          });
          await notification.save();
        }
      }
    }
  } catch (error) {
    console.error('Error checking limit orders:', error.message); // إضافة logging
  }
}

async function fetchPriceFallback(symbol) {
  try {
    const response = await axios.get(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`);
    const currentPrice = parseFloat(response.data.price);
    if (isNaN(currentPrice) || currentPrice <= 0) {
      throw new Error(`Invalid price for ${symbol}: ${response.data.price}`);
    }
    priceMap.set(symbol, currentPrice);
    await checkLimitOrders(symbol, currentPrice);
    await checkFutureOpenTrades(symbol, currentPrice);
    return currentPrice;
  } catch (error) {
    console.error('Error in price fallback:', error.message); // إضافة logging
    return null;
  }
}

async function fetchInitialPrice(symbol) {
  await fetchPriceFallback(symbol);
}

function initializeWebSockets(ioInstance) {
  io = ioInstance;

  TradingPair.find()
    .then((pairs) => {
      if (!pairs || pairs.length === 0) {
        console.warn('No trading pairs found'); // logging
        return;
      }

      pairs.forEach((pair) => {
        const symbol = pair.symbol.toLowerCase();

        fetchInitialPrice(pair.symbol);

        const tickerWs = new WebSocket(`wss://stream.binance.com:9443/ws/${symbol}@ticker`);

        tickerWs.on('message', async (data) => {
          try {
            const ticker = JSON.parse(data);
            const currentPrice = parseFloat(ticker.c);
            if (isNaN(currentPrice) || currentPrice <= 0) {
              return;
            }
            priceMap.set(pair.symbol, currentPrice);
            
            await checkLimitOrders(pair.symbol, currentPrice);
            await checkFutureOpenTrades(pair.symbol, currentPrice);

            if (io) {
              io.emit('price_update', {
                symbol: pair.symbol,
                price: currentPrice,
                timestamp: new Date().toISOString(),
              });
            }
          } catch (error) {
            console.error('WebSocket message error:', error.message);
          }
        });

        tickerWs.on('error', (error) => {
          console.error('WebSocket error:', error.message);
          fetchPriceFallback(pair.symbol);
        });

        tickerWs.on('close', () => {
          console.warn('WebSocket closed, starting fallback interval');
          const interval = setInterval(() => fetchPriceFallback(pair.symbol), 3000);
          tickerWs.on('open', () => clearInterval(interval));
        });
      });
    })
    .catch((err) => {
      console.error('Error initializing WebSockets:', err.message);
    });
}

function getCurrentPrice(symbol) {
  const price = priceMap.get(symbol);
  if (!price || price <= 0) {
    return 0;
  }
  return price;
}

module.exports = {
  initializeWebSockets,
  getCurrentPrice,
};