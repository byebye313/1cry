const { openTrade, getLatestBinancePrice, getCurrentPrediction, closeTrade } = require('../services/aiTradeService');
const { AIWalletBalance } = require('../models/AI_WalletBalance');
const { AITrade } = require('../models/AI_Trade');
const { Asset } = require('../models/Asset');
const { PredictionPayment } = require('../models/PredictionPayment');
const { Notification } = require('../models/Notification');
const { Referral } = require('../models/Refferal');
const fs = require('fs');
const { createCanvas, loadImage } = require('canvas');
const path = require('path');
const startTrade = async (req, res) => {
  const { user_id, ai_wallet_id, investment, leverage, tradeCount, tradeType } = req.body;

  try {
    if (!user_id || typeof user_id !== 'string') {
      return res.status(400).json({ error: 'Invalid user_id' });
    }

    const usdtAsset = await Asset.findOne({ symbol: 'USDT' });
    if (!usdtAsset) {
      return res.status(400).json({ error: 'USDT asset not found' });
    }

    const walletBalance = await AIWalletBalance.findOne({ ai_wallet_id, asset_id: usdtAsset._id });
    if (!walletBalance) {
      return res.status(400).json({ error: 'Wallet balance not found' });
    }

    if (tradeType === 'Automated') {
      const maxInvestment = walletBalance.balance * 0.1;
      if (investment > maxInvestment) {
        return res.status(400).json({ error: 'Investment exceeds 10% of wallet balance' });
      }
    }

    const fee = investment *0;
    const totalDeduction = investment + fee;
    if (walletBalance.balance < totalDeduction) {
      return res.status(400).json({ error: 'Insufficient balance for trade' });
    }

    const trade = await openTrade({
      user_id,
      ai_wallet_id,
      investment,
      leverage,
      tradeCount,
      tradeType,
    });

    const referral = await Referral.findOne({ referred_user_id: user_id, status: 'Pending' });
    if (referral && totalDeduction >= 50) {
      referral.status = 'Eligible';
      referral.trade_met = true;
      referral.trade_amount = totalDeduction;
      await referral.save();

      const referrerNotification = new Notification({
        user_id: referral.referrer_id,
        type: 'Referral',
        title: 'Referral Status Updated',
        message: `Your referral's trade of ${totalDeduction} USDT has met the 50 USDT minimum. Status updated to Eligible!`,
        is_read: false,
      });
      await referrerNotification.save();
    }

    const notification = new Notification({
      user_id,
      type: 'AITrade',
      title: `New ${tradeType} trade opened`,
      message: `A new ${tradeType} trade has been opened with an investment of ${investment} USDT and leverage of ${leverage}x.`,
      is_read: false,
    });
    await notification.save();

    res.status(201).json({
      ...trade.toObject(),
      predicted_price: trade.predicted_price,
      entry_price: trade.entry_price,
      formatted_predicted_price: `$${trade.predicted_price.toFixed(2)}`,
      formatted_entry_price: `$${trade.entry_price.toFixed(2)}`,
    });
  } catch (error) {
    console.error('Error starting trade:', error.message, error.stack);
    res.status(500).json({ error: error.message });
  }
};

const getCurrentPriceAndPrediction = async (req, res) => {
  try {
    const user_id = req.user.id;
    if (!user_id || typeof user_id !== 'string') {
      return res.status(400).json({ error: 'Invalid user_id' });
    }

    const hasPaid = await PredictionPayment.findOne({
      user_id,
      expires_at: { $gt: new Date() },
    });

    if (!hasPaid) {
      return res.status(403).json({ error: 'Payment required to view price prediction' });
    }

    const prediction = getCurrentPrediction();
    if (!prediction) {
      return res.status(500).json({ error: 'No prediction available' });
    }

    res.status(200).json({
      pricePrediction: {
        predictedPrice: prediction.predictedPrice,
        formattedPredictedPrice: `$${prediction.predictedPrice.toFixed(2)}`,
        timestamp: prediction.timestamp,
      },
    });
  } catch (error) {
    console.error('Error fetching price prediction:', error.message, error.stack);
    res.status(500).json({ error: 'Failed to fetch price prediction' });
  }
};

const payForPrediction = async (req, res) => {
  const { user_id, ai_wallet_id } = req.body;

  try {
    if (!user_id || typeof user_id !== 'string') {
      return res.status(400).json({ error: 'Invalid user_id' });
    }

    const usdtAsset = await Asset.findOne({ symbol: 'USDT' });
    if (!usdtAsset) {
      return res.status(400).json({ error: 'USDT asset not found' });
    }

    const walletBalance = await AIWalletBalance.findOne({ ai_wallet_id, asset_id: usdtAsset._id });
    if (!walletBalance) {
      return res.status(400).json({ error: 'Wallet balance not found' });
    }
    if (walletBalance.balance < 1) {
      return res.status(400).json({ error: 'Insufficient balance for prediction payment' });
    }

    await AIWalletBalance.findOneAndUpdate(
      { ai_wallet_id, asset_id: usdtAsset._id },
      { $inc: { balance: -1 } },
      { new: true }
    );

    const expiresAt = new Date(Date.now() + 4 * 60 * 60 * 1000);
    await PredictionPayment.create({
      user_id,
      ai_wallet_id,
      payment_amount: 1,
      created_at: new Date(),
      expires_at: expiresAt,
    });

    const prediction = getCurrentPrediction();
    res.status(200).json({
      message: 'Payment successful',
      pricePrediction: {
        predictedPrice: prediction.predictedPrice,
        formattedPredictedPrice: `$${prediction.predictedPrice.toFixed(2)}`,
        timestamp: prediction.timestamp,
      },
    });
  } catch (error) {
    console.error('Error processing prediction payment:', error.message, error.stack);
    res.status(500).json({ error: error.message });
  }
};

const stopTrade = async (req, res) => {
  const { tradeId } = req.body;
  try {
    const trade = await AITrade.findById(tradeId);
    if (!trade || trade.status !== 'Active') {
      return res.status(400).json({ error: 'Trade not found or not active' });
    }

    const currentPrice = getLatestBinancePrice();
    if (!currentPrice) {
      return res.status(500).json({ error: 'No current price available' });
    }

    const closedTrade = await closeTrade(tradeId, currentPrice, req.io);
    if (!closedTrade) {
      return res.status(400).json({ error: 'Failed to close trade' });
    }

    const notification = new Notification({
      user_id: trade.user_id,
      type: 'AITrade',
      title: 'Trade Closed',
      message: `The ${trade.trade_type} trade has been closed with a result of ${closedTrade.profit_loss.toFixed(2)} USDT.`,
      is_read: false,
    });
    await notification.save();

    res.status(200).json({
      message: 'Trade stopped successfully',
      trade: {
        ...closedTrade.toObject(),
        predicted_price: closedTrade.predicted_price,
        entry_price: closedTrade.entry_price,
        formatted_predicted_price: `$${closedTrade.predicted_price.toFixed(2)}`,
        formatted_entry_price: `$${closedTrade.entry_price.toFixed(2)}`,
        formatted_profit_loss: `$${closedTrade.profit_loss.toFixed(2)}`,
      },
    });
  } catch (error) {
    console.error('Error stopping trade:', error.message, error.stack);
    res.status(500).json({ error: error.message });
  }
};

const getTrades = async (req, res) => {
  try {
    const user_id = req.user.id;
    if (!user_id) {
      return res.status(400).json({ error: 'Invalid user_id' });
    }

    const trades = await AITrade.find({ user_id });
    res.status(200).json(
      trades.map((trade) => ({
        ...trade.toObject(),
        predicted_price: trade.predicted_price,
        entry_price: trade.entry_price,
        formatted_predicted_price: `$${trade.predicted_price.toFixed(2)}`,
        formatted_entry_price: `$${trade.entry_price.toFixed(2)}`,
        formatted_profit_loss: `$${trade.profit_loss.toFixed(2)}`,
      }))
    );
  } catch (error) {
    console.error('Error fetching trades:', error.message, error.stack);
    res.status(500).json({ error: 'Failed to fetch trades' });
  }
};

const cancelRemainingTrades = async (req, res) => {
  const { tradeId } = req.body;
  try {
    const trade = await AITrade.findById(tradeId);
    if (!trade || trade.status !== 'Active') {
      return res.status(400).json({ error: 'Trade not found or not active' });
    }
    if (trade.trade_type !== 'Manual') {
      return res.status(400).json({ error: 'Can only cancel remaining trades for manual trades' });
    }
    if (trade.remaining_trades === 0) {
      return res.status(400).json({ error: 'No remaining trades to cancel' });
    }

    trade.remaining_trades = 0;
    await trade.save();

    res.status(200).json({
      message: 'Remaining trades cancelled successfully',
      trade: {
        ...trade.toObject(),
        remaining_trades: trade.remaining_trades,
      },
    });
  } catch (error) {
    console.error('Error cancelling remaining trades:', error.message, error.stack);
    res.status(500).json({ error: error.message });
  }
};


const generateTradeImage = async (req, res) => {
  try {
    const { tradeId } = req.params;
    console.log(`Generating trade image for tradeId: ${tradeId}`);

    // === 1) جلب بيانات الصفقة كما هي عندك (بدون تغيير) ===
    const trade = await AITrade.findById(tradeId);
    if (!trade) {
      console.log(`Trade not found: ${tradeId}`);
      return res.status(404).json({ error: 'Trade not found' });
    }

    let currentPrice = trade.status === 'Active' ? await getLatestBinancePrice() : null;
    if (trade.status === 'Active' && !currentPrice) {
      console.log('No current price available');
      return res.status(500).json({ error: 'No current price available' });
    }

    let profitLoss, percentage;
    if (trade.status === 'Active') {
      const priceDiff = (currentPrice - trade.entry_price) / trade.entry_price;
      const adjusted = trade.trade_direction === 'Long' ? priceDiff : -priceDiff;
      profitLoss = parseFloat((adjusted * trade.investment * trade.leverage).toFixed(2));
      percentage = parseFloat((adjusted * 100).toFixed(2));
    } else {
      profitLoss = parseFloat(trade.profit_loss.toFixed(2));
      percentage = parseFloat(((trade.profit_loss / trade.investment) * 100).toFixed(2));
    }

    // === 2) تحديد مسار القالب template بصورة موثوقة ===
    // بنحاول عدة احتمالات مع سجل واضح:
    const candidatePaths = [
      path.resolve(__dirname, '..', 'Templates', 'trade_template.png'),       // controllers/../Templates
      path.resolve(process.cwd(), 'Templates', 'trade_template.png'),         // CWD/Templates
      path.resolve(__dirname, '..', 'templates', 'trade_template.png'),       // lowercase
      path.resolve(process.cwd(), 'templates', 'trade_template.png'),
      // إن وضعت الملف داخل مجلد ثابت مثل 'public':
      path.resolve(process.cwd(), 'public', 'Templates', 'trade_template.png'),
      path.resolve(__dirname, '..', 'public', 'Templates', 'trade_template.png'),
    ];

    let templatePath = '';
    for (const p of candidatePaths) {
      if (fs.existsSync(p)) { templatePath = p; break; }
    }

    if (!templatePath) {
      console.error('Trade template image not found in any candidate path:', candidatePaths);
      return res.status(500).json({
        error: 'Template image not found. Ensure Templates/trade_template.png exists on server.',
        tried: candidatePaths
      });
    }

    console.log(`Loading template from: ${templatePath}`);

    // === 3) تحميل الصورة بأمان (يمكن من الملف أو البافر) ===
    // لو واجهت بيئة لا تحب المسارات ذات الأحرف الخاصة، نقرأ الملف كبافر:
    let template;
    try {
      const buf = fs.readFileSync(templatePath);
      template = await loadImage(buf);
    } catch (e) {
      // fallback: جرّب المسار مباشرة
      console.warn('loadImage from buffer failed, retrying with path...', e?.message);
      template = await loadImage(templatePath);
    }

    // === 4) الرسم على الكانفس ===
    const canvas = createCanvas(818, 600);
    const ctx = canvas.getContext('2d');

    ctx.drawImage(template, 0, 0, 818, 600);

    const colors = {
      green: '#00C087',
      red: '#F6465D',
      white: '#FFFFFF',
    };

    const textConfig = [
      { label: 'BTC/USDT', x: 460, y: 202, font: '34px Arial', color: colors.white },
      { label: `${trade.entry_price.toFixed(2)} USDT`, x: 582, y: 393, font: '24px Arial', color: colors.white },
      {
        label: `${(trade.status === 'Active' ? currentPrice : trade.entry_price + (trade.profit_loss / trade.leverage)).toFixed(2)} USDT`,
        x: 582, y: 445, font: '24px Arial', color: colors.white
      },
      { label: `/ ${trade.leverage}x`, x: 700, y: 212, font: '24px Arial', color: colors.white },
      { label: `${trade.trade_direction}`, x: 638, y: 212, font: '24px Arial', color: trade.trade_direction === 'Long' ? colors.green : colors.red },
      { label: `${percentage}%`, x: 560, y: 313, font: '40px Arial', color: percentage >= 0 ? colors.green : colors.red },
    ];

    textConfig.forEach(({ label, x, y, font, color }) => {
      ctx.fillStyle = color;
      ctx.font = font;
      ctx.fillText(String(label), x, y);
    });

    // === 5) إرسال الصورة (PNG) كـ binary ===
    const buffer = canvas.toBuffer('image/png');
    res.set('Content-Type', 'image/png');
    res.send(buffer);
  } catch (error) {
    console.error('Error generating trade image:', {
      message: error.message,
      stack: error.stack,
    });
    res.status(500).json({ error: 'Failed to generate trade image' });
  }
};

module.exports = {
  startTrade,
  getCurrentPriceAndPrediction,
  stopTrade,
  payForPrediction,
  getTrades,
  cancelRemainingTrades,
  generateTradeImage,
};