// services/aiTradeService.js
const axios = require('axios');
const WebSocket = require('ws');
const { AITrade } = require('../models/AI_Trade');
const { AIWalletBalance } = require('../models/AI_WalletBalance');
const { Asset } = require('../models/Asset');
const { PredictionPayment } = require('../models/PredictionPayment');
const { Notification } = require('../models/Notification');
const { Referral } = require('../models/Refferal');
const { SupportPrediction } = require('../models/SupportPrediction');
const { getFourHourWindowUTC } = require('../controllers/supportPredictionController');

let latestBinancePrice = null;
let currentPrediction = null;
let currentWindow = null;
let predictionPollTimer = null;

// Cache active users for 2 minutes
const activeUsersCache = {
  set: new Set(),
  nextRefresh: 0,
  ttlMs: 2 * 60 * 1000,
};
async function getActiveUsers() {
  const now = Date.now();
  if (now < activeUsersCache.nextRefresh && activeUsersCache.set.size) {
    return Array.from(activeUsersCache.set);
  }
  const users = await PredictionPayment.find(
    { expires_at: { $gt: new Date() } },
    { user_id: 1, _id: 0 }
  ).limit(10000).lean();
  activeUsersCache.set = new Set(users.map((u) => String(u.user_id)));
  activeUsersCache.nextRefresh = now + activeUsersCache.ttlMs;
  return Array.from(activeUsersCache.set);
}

function clampPrediction(p) {
  const n = Number(p);
  if (!isFinite(n)) return null;
  if (n < 1000 || n > 150000) return null;
  return Number(n.toFixed(2));
}

function isWithinCurrentWindow(date = new Date()) {
  if (!currentWindow) return false;
  const t = date.getTime();
  return t >= currentWindow.window_start.getTime() && t < currentWindow.window_end.getTime();
}

function calcLiquidationPrice(entry, leverage, direction) {
  const E = Number(entry);
  const L = Number(leverage);
  if (!isFinite(E) || !isFinite(L) || L <= 0) return 0;
  if (direction === 'Long') return Number((E * (1 - 1 / L)).toFixed(2));
  return Number((E * (1 + 1 / L)).toFixed(2));
}

async function resolveSupportPrediction() {
  const { window_start, window_end } = getFourHourWindowUTC(new Date());
  currentWindow = { window_start, window_end };

  const doc = await SupportPrediction.findOne({ window_start, window_end }, { value: 1, source: 1 })
    .sort({ updated_at: -1 })
    .lean();
  if (doc && clampPrediction(doc.value)) {
    currentPrediction = {
      predictedPrice: clampPrediction(doc.value),
      timestamp: Date.now(),
      window_start,
      window_end,
      source: doc.source || 'support',
    };
    return currentPrediction;
  }
  return null;
}

async function resolveServerPrediction() {
  try {
    const resp = await axios.post('http://localhost:5000/predict', null, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 15000,
    });
    const p = clampPrediction(resp.data?.prediction);
    if (!p) throw new Error('Invalid prediction from server model');

    const { window_start, window_end } = getFourHourWindowUTC(new Date());
    currentWindow = { window_start, window_end };

    currentPrediction = {
      predictedPrice: p,
      timestamp: Date.now(),
      window_start,
      window_end,
      source: 'server',
    };

    await SupportPrediction.findOneAndUpdate(
      { window_start, window_end },
      { $set: { value: p, source: 'server', updated_at: new Date() }, $setOnInsert: { created_at: new Date() } },
      { upsert: true, new: true }
    );

    return currentPrediction;
  } catch (err) {
    console.error('Error fetching server prediction:', err.message);
    return null;
  }
}

async function resolveActivePrediction(io, emit = true) {
  let pred = await resolveSupportPrediction();
  if (!pred) pred = await resolveServerPrediction();

  if (pred && emit) {
    io?.emit('price_prediction', {
      predictedPrice: pred.predictedPrice,
      formatted: `$${pred.predictedPrice.toFixed(2)}`,
      timestamp: pred.timestamp,
      window: { start: pred.window_start, end: pred.window_end },
      source: pred.source,
    });

    try {
      const activeUsers = await getActiveUsers();
      for (const user_id of activeUsers) {
        await manageTrades(io, latestBinancePrice, pred.predictedPrice, user_id);
      }
    } catch (e) {
      console.error('Error triggering manageTrades after prediction:', e.message);
    }
  }
  return pred;
}

// Binance WS (single ticker + 4h kline)
let priceWs = null;
let klineWs = null;
let wsConnecting = false;
let wsRetry = 0;

function resetSocket(sock) {
  try { sock?.removeAllListeners?.(); } catch {}
  try { sock?.close?.(); } catch {}
}

function openPriceSockets(io) {
  if (wsConnecting) return;
  wsConnecting = true;

  resetSocket(priceWs);
  resetSocket(klineWs);

  priceWs = new WebSocket('wss://stream.binance.com:9443/ws/btcusdt@ticker');
  klineWs = new WebSocket('wss://stream.binance.com:9443/ws/btcusdt@kline_4h');

  const onOpen = () => { wsRetry = 0; wsConnecting = false; };

  priceWs.on('open', onOpen);
  priceWs.on('message', (data) => {
    try {
      const message = JSON.parse(data);
      const currentPrice = parseFloat(message.c);
      if (!Number.isFinite(currentPrice) || currentPrice <= 0 || currentPrice < 1000 || currentPrice > 150000) return;
      latestBinancePrice = Number(currentPrice.toFixed(2));
      io.emit('current_price', { symbol: 'BTCUSDT', price: latestBinancePrice, formatted: `$${latestBinancePrice.toFixed(2)}` });
    } catch {}
  });
  priceWs.on('error', () => {});
  priceWs.on('close', () => {
    const backoff = Math.min(2000 * Math.pow(2, wsRetry++), 15000);
    setTimeout(() => openPriceSockets(io), backoff);
  });

  klineWs.on('open', onOpen);
  klineWs.on('message', async (data) => {
    try {
      const message = JSON.parse(data);
      if (message.k && message.k.x) { // closed 4h candle
        currentPrediction = null;
        const { window_start, window_end } = getFourHourWindowUTC(new Date());
        currentWindow = { window_start, window_end };
        await resolveActivePrediction(io, true);
        startPredictionPolling(io);

        const activeUsers = await getActiveUsers();
        for (const user_id of activeUsers) {
          await manageTrades(io, latestBinancePrice, currentPrediction?.predictedPrice, user_id);
        }
      }
    } catch (error) {
      console.error('Error processing kline message:', error.message);
    }
  });
  klineWs.on('error', () => {});
  klineWs.on('close', () => {
    const backoff = Math.min(2000 * Math.pow(2, wsRetry++), 15000);
    setTimeout(() => openPriceSockets(io), backoff);
  });

  resolveActivePrediction(io, true).then(() => startPredictionPolling(io)).catch((e) => console.error('Initial prediction error:', e.message));
}

function startPredictionPolling(io) {
  if (predictionPollTimer) clearInterval(predictionPollTimer);
  predictionPollTimer = setInterval(async () => {
    if (!currentPrediction || !isWithinCurrentWindow()) {
      await resolveActivePrediction(io, true);
    }
  }, 60 * 1000);
}

// Open / close AI trades
const openTrade = async ({ user_id, ai_wallet_id, investment, leverage, tradeCount, tradeType }) => {
  try {
    if (!user_id || typeof user_id !== 'string') throw new Error(`Invalid user_id: ${user_id}`);
    if (leverage > 100) throw new Error(`Leverage exceeds maximum allowed (100x): ${leverage}`);

    const usdtAsset = await Asset.findOne({ symbol: 'USDT' }).lean();
    if (!usdtAsset) throw new Error('USDT asset not found');

    const walletBalance = await AIWalletBalance.findOne({ ai_wallet_id, asset_id: usdtAsset._id });
    if (!walletBalance) throw new Error('Wallet balance not found');

    const fee = investment * 0;
    const totalDeduction = investment + fee;
    if (walletBalance.balance < totalDeduction) throw new Error(`Insufficient balance for investment (${investment}) + fee (${fee})`);

    if (!latestBinancePrice) {
      const { data } = await axios.get('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT', { timeout: 8000 });
      const p = parseFloat(data?.price);
      if (!Number.isFinite(p) || p < 1000 || p > 150000) throw new Error('Failed to fetch valid Binance price');
      latestBinancePrice = Number(p.toFixed(2));
    }

    if (!currentPrediction || !isWithinCurrentWindow()) {
      await resolveActivePrediction(null, false);
      if (!currentPrediction) throw new Error('No valid price prediction available');
    }

    const entryPrice = Number(latestBinancePrice);
    const predictedPrice = Number(currentPrediction.predictedPrice.toFixed(2));
    const tradeDirection = predictedPrice > entryPrice ? 'Long' : 'Short';
    const liquidationPrice = calcLiquidationPrice(entryPrice, leverage, tradeDirection);

    const trade = new AITrade({
      user_id,
      ai_wallet_id,
      trading_pair_id: 'BTCUSDT',
      strategy: tradeType === 'Manual' ? 'Manual Trade' : 'AI Automated',
      investment,
      leverage,
      predicted_price: predictedPrice,
      entry_price: entryPrice,
      trade_type: tradeType,
      trade_direction: tradeDirection,
      total_trades: tradeCount,
      remaining_trades: tradeCount - 1,
      created_at: new Date(),
      margin_type: 'Cross',
      tax_rate: 0,
      tax_amount: 0,
      net_profit: 0,
      liquidation_price: liquidationPrice,
      liquidated: false,
      liquidation_reason: 'Manual',
    });

    const updatedBalance = await AIWalletBalance.findOneAndUpdate(
      { ai_wallet_id, asset_id: usdtAsset._id, balance: { $gte: totalDeduction } },
      { $inc: { balance: -totalDeduction } },
      { new: true }
    );
    if (!updatedBalance) throw new Error('Failed to deduct balance: insufficient funds or concurrent modification');

    await trade.save();

    try {
      const referral = await Referral.findOne({ referred_user_id: user_id, status: 'Pending' }).lean();
      if (referral && totalDeduction >= 50) {
        await Referral.updateOne(
          { _id: referral._id },
          { $set: { status: 'Eligible', trade_met: true, trade_amount: totalDeduction } }
        );
        await Notification.create({
          user_id: referral.referrer_id,
          type: 'Referral',
          title: 'Referral Status Updated',
          message: `Your referral's trade of ${totalDeduction} USDT has met the 50 USDT minimum. Status updated to Eligible!`,
          is_read: false,
        });
      }
    } catch (e) {
      console.warn('Referral update warning:', e.message);
    }

    return trade;
  } catch (error) {
    console.error('Error opening trade:', error.message);
    throw error;
  }
};

async function computeTaxForProfit(ai_wallet_id, rawProfit) {
  if (rawProfit <= 0) return { rate: 0, amount: 0, net: rawProfit };
  const usdtAsset = await Asset.findOne({ symbol: 'USDT' }).lean();
  const balDoc = await AIWalletBalance.findOne({ ai_wallet_id, asset_id: usdtAsset._id }, { balance: 1 }).lean();
  const balance = balDoc?.balance ?? 0;
  let rate = 0;
  if (balance <= 100) rate = 0.50;
  else if (balance <= 200) rate = 0.35;
  else if (balance < 500) rate = 0.20;
  else if (balance < 1000) rate = 0.10;
  else rate = 0.03;
  const amount = Number((rawProfit * rate).toFixed(2));
  const net = Number((rawProfit - amount).toFixed(2));
  return { rate, amount, net };
}

const closeTrade = async (tradeId, currentPrice, io, reason = 'Manual') => {
  try {
    const trade = await AITrade.findOne({ _id: tradeId, status: 'Active' });
    if (!trade) return null;

    const priceDiff = (currentPrice - trade.entry_price) / trade.entry_price;
    const adjustedDiff = trade.trade_direction === 'Long' ? priceDiff : -priceDiff;
    let profitLoss = Number((adjustedDiff * trade.investment * trade.leverage).toFixed(2));
    if (profitLoss < -trade.investment) profitLoss = -trade.investment;

    const { rate, amount, net } = await computeTaxForProfit(trade.ai_wallet_id, profitLoss);

    trade.profit_loss = profitLoss;
    trade.tax_rate = rate;
    trade.tax_amount = amount;
    trade.net_profit = net;
    trade.status = 'Completed';
    trade.liquidated = reason === 'HitLiquidation';
    trade.liquidation_reason = reason;

    await trade.save();

    const usdtAsset = await Asset.findOne({ symbol: 'USDT' }).lean();
    const balanceAdjustment = trade.investment + trade.net_profit;
    const updatedBalance = await AIWalletBalance.findOneAndUpdate(
      { ai_wallet_id: trade.ai_wallet_id, asset_id: usdtAsset._id },
      { $inc: { balance: balanceAdjustment } },
      { new: true }
    );

    io?.to(String(trade.user_id)).emit('trade_closed', {
      tradeId: trade._id,
      status: 'Completed',
      reason,
      profit_loss: trade.profit_loss,
      net_profit: trade.net_profit,
      tax_rate: trade.tax_rate,
      tax_amount: trade.tax_amount,
      formatted_net_profit: `$${trade.net_profit.toFixed(2)}`,
      liquidation_price: trade.liquidation_price,
      liquidated: trade.liquidated,
      new_balance: updatedBalance?.balance,
    });

    return trade;
  } catch (error) {
    console.error('Error closing trade:', error.message);
    throw error;
  }
};

const manageTrades = async (io, currentPrice, predictedPrice, user_id) => {
  try {
    if (!user_id) return;
    if (!Number.isFinite(currentPrice)) return;

    const activeTrades = await AITrade.find(
      { user_id, status: 'Active' },
      { _id: 1, user_id: 1, trade_type: 1, trade_direction: 1, predicted_price: 1, liquidation_price: 1,
        investment: 1, leverage: 1, ai_wallet_id: 1, entry_price: 1 }
    ).lean();

    for (const trade of activeTrades) {
      const liq = Number(trade.liquidation_price || 0);
      let hitLiq = false;
      if (trade.trade_direction === 'Long')  { if (liq > 0 && currentPrice <= liq) hitLiq = true; }
      else                                   { if (liq > 0 && currentPrice >= liq) hitLiq = true; }
      if (hitLiq) {
        await closeTrade(trade._id, currentPrice, io, 'HitLiquidation');
        continue;
      }

      const isTargetReached = Math.abs(currentPrice - trade.predicted_price) <= 0.005 * trade.predicted_price;

      const haveActivePrediction = currentPrediction && isWithinCurrentWindow();
      let newDirection = null;
      if (haveActivePrediction) {
        newDirection = currentPrediction.predictedPrice > currentPrice ? 'Long' : 'Short';
      }
      const isOpposite = haveActivePrediction && newDirection && (newDirection !== trade.trade_direction);

      if (isTargetReached || (trade.trade_type === 'Automated' && isOpposite)) {
        const reason = isTargetReached ? 'Target' : 'OppositeSignal';
        await closeTrade(trade._id, currentPrice, io, reason);

        if (trade.trade_type === 'Automated' && isOpposite) {
          const newTrade = await openTrade({
            user_id: trade.user_id,
            ai_wallet_id: trade.ai_wallet_id,
            investment: trade.investment,
            leverage: trade.leverage,
            tradeCount: 1,
            tradeType: 'Automated',
          });
          io?.to(String(user_id)).emit('trade_opened', {
            ...newTrade.toObject(),
            predicted_price: newTrade.predicted_price,
            entry_price: newTrade.entry_price,
            formatted_predicted_price: `$${newTrade.predicted_price.toFixed(2)}`,
            formatted_entry_price: `$${newTrade.entry_price.toFixed(2)}`,
          });
        }
      }
    }
  } catch (error) {
    console.error('Error managing trades:', error.message, error.stack);
  }
};

const getLatestBinancePrice = () => latestBinancePrice;
const getCurrentPrediction = () => currentPrediction;

module.exports = {
  initializePriceWebSocket: (io) => openPriceSockets(io),
  openTrade,
  closeTrade,
  manageTrades,
  getLatestBinancePrice,
  getCurrentPrediction,
};
