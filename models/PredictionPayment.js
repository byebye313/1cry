const mongoose = require('mongoose');

const predictionPaymentSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId , required: true ,ref: 'User',},
  ai_wallet_id: { type: mongoose.Schema.Types.ObjectId, required: true ,  ref: 'AIWallet'},
  payment_amount: { type: Number, required: true, default: 1 }, // 1 USDT
  created_at: { type: Date, default: Date.now },
  expires_at: { type: Date, required: true }, // 4-hour expiry
});

module.exports = {PredictionPayment: mongoose.model('PredictionPayment', predictionPaymentSchema)};