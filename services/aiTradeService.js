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
let currentPrediction = null;        // { predictedPrice, timestamp, window_start, window_end, source }
let currentWindow = null;            // { window_start, window_end }
let predictionPollTimer = null;

// === Helpers ===
function nowUtc() { return new Date(); }

function clampPrediction(p) {
  const n = Number(p);
  if (!isFinite(n)) return null;
  if (n < 1000 || n > 150000) return null;
  return Number(n.toFixed(2));
}

function clearPredictionPolling() {
  if (predictionPollTimer) {
    clearInterval(predictionPollTimer);
    predictionPollTimer = null;
  }
}

function startPredictionPolling(io) {
  clearPredictionPolling();
  predictionPollTimer = setInterval(async () => {
    // في النافذة الحالية، إن لم توجد قيمة تنبؤ فعالة → حاول جلب/حلّ تنبؤ
    if (!currentPrediction || !isWithinCurrentWindow()) {
      await resolveActivePrediction(io, true);
    }
  }, 30 * 1000); // كل 30 ثانية
}

function isWithinCurrentWindow(date = new Date()) {
  if (!currentWindow) return false;
  const t = date.getTime();
  return t >= currentWindow.window_start.getTime() && t < currentWindow.window_end.getTime();
}

// سعر التصفية التقريبي بناءً على “خسارة قصوى = الاستثمار”:
// Long:  L = leverage, E = entry => P_liq = E * (1 - 1/L)
// Short: P_liq = E * (1 + 1/L)
function calcLiquidationPrice(entry, leverage, direction) {
  const E = Number(entry);
  const L = Number(leverage);
  if (!isFinite(E) || !isFinite(L) || L <= 0) return 0;
  if (direction === 'Long') {
    return Number((E * (1 - 1 / L)).toFixed(2));
  }
  return Number((E * (1 + 1 / L)).toFixed(2));
}

async function resolveSupportPrediction() {
  const { window_start, window_end } = getFourHourWindowUTC(new Date());
  currentWindow = { window_start, window_end };

  const doc = await SupportPrediction.findOne({ window_start, window_end }).sort({ updated_at: -1 });
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
      timeout: 30000,
    });
    const p = clampPrediction(resp.data?.prediction);
    if (!p) throw new Error('Invalid or unrealistic prediction received');

    const { window_start, window_end } = getFourHourWindowUTC(new Date());
    currentWindow = { window_start, window_end };

    currentPrediction = {
      predictedPrice: p,
      timestamp: Date.now(),
      window_start,
      window_end,
      source: 'server',
    };

    // حفظ نسخة (اختياري)
    await SupportPrediction.findOneAndUpdate(
      { window_start, window_end },
      { $set: { value: p, source: 'server', created_by: null, updated_at: new Date() }, $setOnInsert: { created_at: new Date() } },
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

    // طبّق الاستراتيجية فور وصول التنبؤ
    try {
      const activeUsers = await PredictionPayment.find({
        expires_at: { $gt: new Date() },
      }).distinct('user_id');

      for (const user_id of activeUsers) {
        if (typeof user_id !== 'string') continue;
        await manageTrades(io, latestBinancePrice, pred.predictedPrice, user_id);
      }
    } catch (e) {
      console.error('Error triggering manageTrades after prediction:', e.message);
    }
  }
  return pred;
}

// === WebSockets (Binance) ===
const initializePriceWebSocket = (io) => {
  const priceWs = new WebSocket('wss://stream.binance.com:9443/ws/btcusdt@ticker');

  priceWs.on('message', async (data) => {
    try {
      const message = JSON.parse(data);
      const currentPrice = parseFloat(message.c);
      if (isNaN(currentPrice) || currentPrice <= 0 || currentPrice < 1000 || currentPrice > 150000) {
        console.warn('Invalid Binance price received:', currentPrice);
        return;
      }
      latestBinancePrice = parseFloat(currentPrice.toFixed(2));
      io.emit('current_price', { symbol: 'BTCUSDT', price: latestBinancePrice, formatted: `$${latestBinancePrice.toFixed(2)}` });
    } catch (error) {
      console.error('Error processing price WebSocket message:', error.message);
    }
  });

  priceWs.on('error', (error) => console.error('Price WebSocket error:', error.message));
  priceWs.on('close', () => {
    console.log('Price WebSocket closed, reconnecting in 2 seconds...');
    setTimeout(() => initializePriceWebSocket(io), 2000);
  });

  const klineWs = new WebSocket('wss://stream.binance.com:9443/ws/btcusdt@kline_4h');

  klineWs.on('message', async (data) => {
    try {
      const message = JSON.parse(data);
      if (message.k && message.k.x) {
        // نهاية شمعة 4H: ابدأ نافذة جديدة
        currentPrediction = null;
        const { window_start, window_end } = getFourHourWindowUTC(new Date());
        currentWindow = { window_start, window_end };
        await resolveActivePrediction(io, true);
        startPredictionPolling(io);

        // فعّل إدارة الصفقات للمستخدمين المؤهلين
        const activeUsers = await PredictionPayment.find({
          expires_at: { $gt: new Date() },
        }).distinct('user_id');
        for (const user_id of activeUsers) {
          if (typeof user_id !== 'string') continue;
          await manageTrades(io, latestBinancePrice, currentPrediction?.predictedPrice, user_id);
        }
      }
    } catch (error) {
      console.error('Error processing kline WebSocket message:', error.message);
    }
  });

  klineWs.on('error', (error) => console.error('Kline WebSocket error:', error.message));
  klineWs.on('close', () => {
    console.log('Kline WebSocket closed, reconnecting in 2 seconds...');
    setTimeout(() => initializePriceWebSocket(io), 2000);
  });

  // تنبؤ ابتدائي عند التشغيل
  resolveActivePrediction(io, true).then(() => startPredictionPolling(io)).catch((e) => console.error('Initial prediction error:', e.message));
};

// === فتح صفقة ===
const openTrade = async ({ user_id, ai_wallet_id, investment, leverage, tradeCount, tradeType }) => {
  try {
    if (!user_id || typeof user_id !== 'string') throw new Error(`Invalid user_id: ${user_id}`);
    if (leverage > 100) throw new Error(`Leverage exceeds maximum allowed (100x): ${leverage}`);

    const usdtAsset = await Asset.findOne({ symbol: 'USDT' });
    if (!usdtAsset) throw new Error('USDT asset not found');

    const walletBalance = await AIWalletBalance.findOne({ ai_wallet_id, asset_id: usdtAsset._id });
    if (!walletBalance) throw new Error('Wallet balance not found');

    const fee = investment * 0;
    const totalDeduction = investment + fee;
    if (walletBalance.balance < totalDeduction) throw new Error(`Insufficient balance for investment (${investment}) + fee (${fee})`);

    if (!latestBinancePrice) {
      const binanceResponse = await axios.get('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT');
      latestBinancePrice = parseFloat(binanceResponse.data.price).toFixed(2);
      if (!latestBinancePrice || latestBinancePrice < 1000 || latestBinancePrice > 150000) {
        throw new Error('Failed to fetch valid Binance price');
      }
    }

    // تأكد من وجود تنبؤ فعّال ضمن نافذة 4H الحالية
    if (!currentPrediction || !isWithinCurrentWindow()) {
      await resolveActivePrediction(null, false);
      if (!currentPrediction) throw new Error('No valid price prediction available');
    }

    const entryPrice = parseFloat(latestBinancePrice);
    const predictedPrice = parseFloat(currentPrediction.predictedPrice.toFixed(2));
    const tradeDirection = predictedPrice > entryPrice ? 'Long' : 'Short';

    // حساب سعر التصفية (خسارة قصوى = الاستثمار)
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

    // منطق الإحالة (اختياري)
    try {
      const referral = await Referral.findOne({ referred_user_id: user_id, status: 'Pending' });
      if (referral && totalDeduction >= 50) {
        referral.status = 'Eligible';
        referral.trade_met = true;
        referral.trade_amount = totalDeduction;
        await referral.save();
        const refNotif = new Notification({
          user_id: referral.referrer_id,
          type: 'Referral',
          title: 'Referral Status Updated',
          message: `Your referral's trade of ${totalDeduction} USDT has met the 50 USDT minimum. Status updated to Eligible!`,
          is_read: false,
        });
        await refNotif.save();
      }
    } catch (e) {
      console.warn('Referral update warning:', e.message);
    }

    console.log('Trade opened:', {
      tradeId: trade._id,
      user_id,
      investment,
      fee,
      totalDeduction,
      entry_price: trade.entry_price,
      trade_direction: trade.trade_direction,
      liquidation_price: trade.liquidation_price,
      newBalance: updatedBalance.balance,
    });

    return trade;
  } catch (error) {
    console.error('Error opening trade:', error.message, error.stack);
    throw error;
  }
};

// === حساب ضريبة الربح حسب رصيد محفظة AI (USDT) ===
async function computeTaxForProfit(ai_wallet_id, rawProfit) {
  if (rawProfit <= 0) return { rate: 0, amount: 0, net: rawProfit };

  const usdtAsset = await Asset.findOne({ symbol: 'USDT' });
  const balDoc = await AIWalletBalance.findOne({ ai_wallet_id, asset_id: usdtAsset._id });
  const balance = balDoc?.balance || 0;

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

// === إغلاق صفقة (مع التصفية) ===
const closeTrade = async (tradeId, currentPrice, io, reason = 'Manual') => {
  try {
    const trade = await AITrade.findOne({ _id: tradeId, status: 'Active' });
    if (!trade) {
      console.warn(`Trade not found or not active: ${tradeId}`);
      return null;
    }

    const priceDiff = (currentPrice - trade.entry_price) / trade.entry_price;
    const adjustedDiff = trade.trade_direction === 'Long' ? priceDiff : -priceDiff;
    let profitLoss = Number((adjustedDiff * trade.investment * trade.leverage).toFixed(2));

    // حدّ الخسارة الأدنى = -investment (لا ضرائب على الخسارة)
    if (profitLoss < -trade.investment) profitLoss = -trade.investment;

    const { rate, amount, net } = await computeTaxForProfit(trade.ai_wallet_id, profitLoss);

    trade.profit_loss = profitLoss;
    trade.tax_rate = rate;
    trade.tax_amount = amount;
    trade.net_profit = net;
    trade.status = 'Completed';

    if (reason === 'HitLiquidation') {
      trade.liquidated = true;
      trade.liquidation_reason = 'HitLiquidation';
    } else if (reason === 'OppositeSignal') {
      trade.liquidation_reason = 'OppositeSignal';
    } else if (reason === 'Target') {
      trade.liquidation_reason = 'Target';
    } else {
      trade.liquidation_reason = 'Manual';
    }

    await trade.save();

    const usdtAsset = await Asset.findOne({ symbol: 'USDT' });
    const balanceAdjustment = trade.investment + trade.net_profit; // الربح الصافي قد يكون سالباً
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

    console.log('Trade closed:', {
      tradeId,
      reason,
      profitLoss: trade.profit_loss,
      tax_rate: rate,
      tax_amount: amount,
      net_profit: net,
      balanceAdjustment,
      newBalance: updatedBalance?.balance,
    });

    return trade;
  } catch (error) {
    console.error('Error closing trade:', error.message, error.stack);
    throw error;
  }
};

// === إدارة الصفقات (هدف / معاكس / تصفية) ===
const manageTrades = async (io, currentPrice, predictedPrice, user_id) => {
  try {
    if (!user_id || typeof user_id !== 'string') return;
    if (!currentPrice || !isFinite(currentPrice)) return;

    const activeTrades = await AITrade.find({ user_id, status: 'Active' });

    for (const trade of activeTrades) {
      // 1) التصفية أولاً
      const liq = trade.liquidation_price || 0;
      let hitLiq = false;
      if (trade.trade_direction === 'Long') {
        if (liq > 0 && currentPrice <= liq) hitLiq = true;
      } else {
        if (liq > 0 && currentPrice >= liq) hitLiq = true;
      }
      if (hitLiq) {
        await closeTrade(trade._id, currentPrice, io, 'HitLiquidation');
        continue; // ننتقل للصفقة التالية
      }

      // 2) تحقق الهدف
      const isTargetReached =
        Math.abs(currentPrice - trade.predicted_price) <= 0.005 * trade.predicted_price;

      // 3) اتجاه التنبؤ الحالي (إن وُجد)
      let haveActivePrediction = currentPrediction && isWithinCurrentWindow();
      let newDirection = null;
      if (haveActivePrediction && currentPrice) {
        newDirection = currentPrediction.predictedPrice > currentPrice ? 'Long' : 'Short';
      }

      const isOpposite = haveActivePrediction && newDirection && (newDirection !== trade.trade_direction);
      const isSame     = haveActivePrediction && newDirection && (newDirection === trade.trade_direction);

      // الإغلاق:
      // - إذا وصل الهدف ⇒ أغلق
      // - إذا Automated وظهر تنبؤ معاكس ⇒ أغلق وافتح صفقة جديدة بالعكس
      if (isTargetReached || (trade.trade_type === 'Automated' && isOpposite)) {
        const reason = isTargetReached ? 'Target' : 'OppositeSignal';
        const closed = await closeTrade(trade._id, currentPrice, io, reason);

        if (closed && trade.trade_type === 'Automated' && isOpposite) {
          // افتح صفقة جديدة بنفس الاستثمار والرافعة
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
      } else {
        // إذا نفس الاتجاه ⇒ أبقِها مفتوحة
        // إذا لا يوجد تنبؤ ⇒ أبقِها مفتوحة
      }
    }
  } catch (error) {
    console.error('Error managing trades:', error.message, error.stack);
  }
};

const getLatestBinancePrice = () => latestBinancePrice;
const getCurrentPrediction = () => currentPrediction;

module.exports = {
  initializePriceWebSocket,
  openTrade,
  closeTrade,
  manageTrades,
  getLatestBinancePrice,
  getCurrentPrediction,
};
