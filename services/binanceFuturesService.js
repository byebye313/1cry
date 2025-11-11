const WebSocket = require('ws');
const axios = require('axios');
const { OrderBook } = require('../models/OrderBook');
const { FutureTrade } = require('../models/FutureTrade');
const { FuturesTradeHistory } = require('../models/FutureTradeHistory');
const { FuturesWalletBalance } = require('../models/FutureWalletBalance');
const { TradingPair } = require('../models/TradingPair');

const priceMap = new Map();
const orderBookMap = new Map();
const priceCache = new Map();
const CACHE_DURATION = 5000;
let io;

async function fetchPriceFromBinance(symbol, fetchExchangeInfo = false) {
  if (fetchExchangeInfo) {
    try {
      const response = await axios.get('https://fapi.binance.com/fapi/v1/exchangeInfo', {
        timeout: 10000,
      });
      return response.data;
    } catch (error) {
      throw error;
    }
  }

  const cachedPrice = priceCache.get(symbol);
  if (cachedPrice && Date.now() - cachedPrice.timestamp < CACHE_DURATION) {
    return cachedPrice.price;
  }

  const maxRetries = 2;
  let retryCount = 0;

  while (retryCount <= maxRetries) {
    try {
      const response = await axios.get(`https://fapi.binance.com/fapi/v1/ticker/price?symbol=${symbol}`, {
        timeout: 10000,
      });
      const currentPrice = parseFloat(response.data.price);
      if (isNaN(currentPrice) || currentPrice <= 0) {
        throw new Error(`Invalid price for ${symbol}: ${response.data.price}`);
      }
      priceMap.set(symbol, currentPrice);
      priceCache.set(symbol, { price: currentPrice, timestamp: Date.now() });
      await checkLimitOrders(symbol, currentPrice);
      await checkLiquidation(symbol, currentPrice);
      return currentPrice;
    } catch (error) {
      retryCount++;
      if (retryCount > maxRetries) {
        return null;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

async function fetchOrderBookFallback(symbol) {
  try {
    const response = await axios.get(`https://fapi.binance.com/fapi/v1/depth`, {
      params: { symbol: symbol.toUpperCase(), limit: 20 },
      timeout: 10000,
    });
    const validBids = Array.isArray(response.data.bids)
      ? response.data.bids.map(([price, amount]) => [parseFloat(price), parseFloat(amount)])
      : [];
    const validAsks = Array.isArray(response.data.asks)
      ? response.data.asks.map(([price, amount]) => [parseFloat(price), parseFloat(amount)])
      : [];
    if (validBids.length === 0 && validAsks.length === 0) {
      throw new Error(`Invalid order book data for ${symbol}`);
    }
    orderBookMap.set(symbol, {
      bids: validBids,
      asks: validAsks,
      timestamp: new Date().toISOString(),
    });
    const currentPrice = priceMap.get(symbol) || (validBids.length > 0 ? validBids[0][0] : null);
    if (io) {
      io.emit('futures_order_book_update', {
        symbol,
        bids: validBids,
        asks: validAsks,
        currentPrice,
        timestamp: new Date().toISOString(),
      });
    }
  } catch (error) {
    // No logging
  }
}

async function fetchInitialPrice(symbol) {
  const price = await fetchPriceFromBinance(symbol);
  if (!price) {
    // No logging
  }
}

async function initializeFuturesWebSockets(ioInstance) {
  io = ioInstance;
  let pairs = await TradingPair.find();
  if (!pairs || pairs.length === 0) {
    const usdtAsset = await require('../models/Asset').findOne({ symbol: 'USDT' });
    const btcAsset = await require('../models/Asset').findOne({ symbol: 'BTC' });
    if (usdtAsset && btcAsset) {
      const btcusdtPair = new TradingPair({
        symbol: 'BTCUSDT',
        base_asset_id: btcAsset._id,
        quote_asset_id: usdtAsset._id,
      });
      await btcusdtPair.save();
      pairs = [btcusdtPair];
    } else {
      return;
    }
  }

  pairs.forEach((pair) => {
    const symbol = pair.symbol.toLowerCase();
    fetchInitialPrice(pair.symbol);

    const connectPriceWs = () => {
      const priceWs = new WebSocket(`wss://fstream.binance.com/ws/${symbol}@ticker`);
      priceWs.on('open', () => {});
      priceWs.on('message', (data) => {
        try {
          const ticker = JSON.parse(data);
          const currentPrice = parseFloat(ticker.c);
          if (isNaN(currentPrice) || currentPrice <= 0) {
            return;
          }
          priceMap.set(pair.symbol, currentPrice);
          priceCache.set(pair.symbol, { price: currentPrice, timestamp: Date.now() });
          checkLimitOrders(pair.symbol, currentPrice);
          checkLiquidation(pair.symbol, currentPrice);
          if (io) {
            io.emit('futures_price_update', {
              symbol: pair.symbol,
              price: currentPrice,
              timestamp: new Date().toISOString(),
            });
          }
        } catch (error) {
          // No logging
        }
      });
      priceWs.on('error', (error) => {
        fetchPriceFromBinance(pair.symbol);
      });
      priceWs.on('close', () => {
        setTimeout(connectPriceWs, 3000);
      });
    };

    const connectOrderBookWs = () => {
      const orderBookWs = new WebSocket(`wss://fstream.binance.com/ws/${symbol}@depth20@100ms`);
      orderBookWs.on('open', () => {});
      orderBookWs.on('message', (data) => {
        try {
          const orderBook = JSON.parse(data);
          const validBids = Array.isArray(orderBook.bids)
            ? orderBook.bids
                .map(([price, amount]) => [parseFloat(price), parseFloat(amount)])
                .filter(([price, amount]) => !isNaN(price) && !isNaN(amount))
            : [];
          const validAsks = Array.isArray(orderBook.asks)
            ? orderBook.asks
                .map(([price, amount]) => [parseFloat(price), parseFloat(amount)])
                .filter(([price, amount]) => !isNaN(price) && !isNaN(amount))
            : [];
          if (validBids.length === 0 && validAsks.length === 0) {
            return;
          }
          const currentPrice = priceMap.get(pair.symbol) || (validBids.length > 0 ? validBids[0][0] : null);
          orderBookMap.set(symbol, {
            bids: validBids,
            asks: validAsks,
            timestamp: new Date().toISOString(),
          });
          if (io) {
            io.emit('futures_order_book_update', {
              symbol: pair.symbol,
              bids: validBids,
              asks: validAsks,
              currentPrice,
              timestamp: new Date().toISOString(),
            });
          }
        } catch (error) {
          // No logging
        }
      });
      orderBookWs.on('error', (error) => {
        fetchOrderBookFallback(pair.symbol);
      });
      orderBookWs.on('close', () => {
        setTimeout(connectOrderBookWs, 3000);
      });
    };

    connectPriceWs();
    connectOrderBookWs();
  });

  setInterval(() => {
    const now = Date.now();
    for (const [symbol, { timestamp }] of priceCache) {
      if (now - timestamp > CACHE_DURATION * 2) {
        priceCache.delete(symbol);
        priceMap.delete(symbol);
        orderBookMap.delete(symbol);
      }
    }
  }, 60000);
}

async function checkLimitOrders(symbol, currentPrice) {
  try {
    if (!currentPrice || currentPrice <= 0) {
      io.emit('error', { message: `Invalid current price for ${symbol}` });
      return;
    }

    const tradingPair = await TradingPair.findOne({ symbol });
    if (!tradingPair) {
      io.emit('error', { message: `Trading pair ${symbol} not found` });
      return;
    }

    const orders = await OrderBook.find({
      trading_pair_id: tradingPair._id,
      status: 'Pending',
      order_type: 'Futures',
    });

    if (orders.length === 0) {
      return;
    }

    for (const order of orders) {
      if (!order.price || order.price <= 0) {
        order.status = 'Failed';
        await order.save();
        io.emit('error', { message: `Invalid limit price for order ${order._id}` });
        continue;
      }

      const trade = await FutureTrade.findById(order.trade_id);
      if (!trade) {
        order.status = 'Failed';
        await order.save();
        io.emit('error', { message: `Trade ${order.trade_id} not found` });
        continue;
      }

      const isBuyOrder = order.trade_type === 'Buy';
      const priceReached = isBuyOrder
        ? currentPrice <= order.price
        : currentPrice >= order.price;

      if (priceReached) {
        trade.open_price = currentPrice;
        trade.status = 'Filled';
        order.status = 'Filled';

        await trade.save();
        await order.save();

        await openPosition(trade, tradingPair);

        if (io) {
          io.emit('futures_order_status_update', {
            trade_id: trade._id.toString(),
            status: trade.status,
            symbol: tradingPair.symbol,
            open_price: trade.open_price,
            timestamp: new Date().toISOString(),
          });
        }
      }
    }
  } catch (error) {
    io.emit('error', { message: `Error processing orders for ${symbol}: ${error.message}` });
  }
}

setInterval(async () => {
  try {
    const tradingPairs = await TradingPair.find({});
    for (const pair of tradingPairs) {
      const currentPrice = getCurrentPrice(pair.symbol);
      if (currentPrice && currentPrice > 0) {
        await checkLimitOrders(pair.symbol, currentPrice);
      }
    }
  } catch (error) {
    // No logging
  }
}, 60000);

async function checkLiquidation(symbol, currentPrice) {
  try {
    const tradingPair = await TradingPair.findOne({ symbol });
    if (!tradingPair) {
      io.emit('error', { message: `Trading pair ${symbol} not found` });
      return;
    }

    const trades = await FutureTrade.find({
      trading_pair_id: tradingPair._id,
      status: 'Filled',
    });

    for (const trade of trades) {
      if (
        (trade.position === 'Long' && currentPrice <= trade.liquidation_price) ||
        (trade.position === 'Short' && currentPrice >= trade.liquidation_price)
      ) {
        trade.status = 'Liquidated';
        trade.close_price = currentPrice;
        await trade.save();
        await liquidatePosition(trade);
        if (io) {
          io.emit('futures_trade_liquidated', {
            trade_id: trade._id.toString(),
            symbol: tradingPair.symbol,
            close_price: currentPrice,
            timestamp: new Date().toISOString(),
          });
        }
      }
    }
  } catch (error) {
    io.emit('error', { message: `Error processing liquidation for ${symbol}: ${error.message}` });
  }
}

async function openPosition(trade, tradingPair) {
  try {
    const history = new FuturesTradeHistory({
      future_trade_id: trade._id,
      user_id: trade.user_id,
      trading_pair_id: trade.trading_pair_id,
      price: trade.open_price,
      amount: trade.amount,
      fee: (trade.amount * trade.open_price * 0.001) / trade.leverage,
      position: trade.position,
      executed_at: new Date(),
    });
    await history.save();

    let balance = await FuturesWalletBalance.findOne({
      futures_wallet_id: trade.futures_wallet_id,
      asset_id: tradingPair.quote_asset_id,
    });
    if (!balance) {
      balance = new FuturesWalletBalance({
        futures_wallet_id: trade.futures_wallet_id,
        asset_id: tradingPair.quote_asset_id,
        balance: 0,
      });
    }

    const margin = (trade.amount * trade.open_price) / trade.leverage;
    balance.balance -= margin + history.fee;
    if (balance.balance < 0) throw new Error('Insufficient balance to open position');
    await balance.save();
  } catch (error) {
    io.emit('error', { message: `Error opening position ${trade._id}: ${error.message}` });
    throw error;
  }
}

async function closePosition(trade, closePrice) {
  try {
    trade.close_price = closePrice;
    trade.status = trade.status === 'Filled' ? 'Closed' : 'Liquidated';
    await trade.save();

    const history = new FuturesTradeHistory({
      future_trade_id: trade._id,
      user_id: trade.user_id,
      trading_pair_id: trade.trading_pair_id,
      price: closePrice,
      amount: trade.amount,
      fee: (trade.amount * closePrice * 0.001) / trade.leverage,
      position: trade.position,
      executed_at: new Date(),
    });
    await history.save();

    let balance = await FuturesWalletBalance.findOne({
      futures_wallet_id: trade.futures_wallet_id,
      asset_id: (await TradingPair.findById(trade.trading_pair_id)).quote_asset_id,
    });
    const margin = (trade.amount * trade.open_price) / trade.leverage;
    const pnl =
      trade.position === 'Long'
        ? (closePrice - trade.open_price) * trade.amount
        : (trade.open_price - closePrice) * trade.amount;
    balance.balance += margin + pnl - history.fee;
    await balance.save();
  } catch (error) {
    io.emit('error', { message: `Error closing position ${trade._id}: ${error.message}` });
    throw error;
  }
}

async function liquidatePosition(trade) {
  await closePosition(trade, trade.close_price);
}

function getCurrentPrice(symbol) {
  const price = priceMap.get(symbol);
  if (!price || price <= 0) {
    return 0;
  }
  return price;
}

function getOrderBook(symbol) {
  return orderBookMap.get(symbol) || { bids: [], asks: [], timestamp: new Date().toISOString() };
}

module.exports = {
  initializeFuturesWebSockets,
  openPosition,
  closePosition,
  fetchPriceFromBinance,
  getCurrentPrice,
  getOrderBook,
};