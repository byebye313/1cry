// backend/models/SpotTrade.js
const mongoose = require('mongoose');
const Joi = require('joi');

const spotTradeSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  spot_wallet_id: { type: mongoose.Schema.Types.ObjectId, ref: 'SpotWallet', required: true },
  trading_pair_id: { type: mongoose.Schema.Types.ObjectId, ref: 'TradingPair', required: true },
  trade_type: { type: String, enum: ['Buy', 'Sell'], required: true },
  order_type: { type: String, enum: ['Market', 'Limit'], required: true },
  limit_price: { type: Number, min: 0, default: null },
  amount: { type: Number, required: true, min: 0 },
  executed_price: { type: Number, min: 0, default: null },
  status: { type: String, enum: ['Pending', 'Filled', 'Cancelled'], default: 'Pending' },
  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now },
});

spotTradeSchema.pre('save', function (next) {
  this.updated_at = Date.now();
  next();
});

const spotTradeValidationSchema = Joi.object({
  trading_pair_id: Joi.string().required(), // السماح بإرسال trading_pair_id
  trade_type: Joi.string().valid('Buy', 'Sell').required(),
  order_type: Joi.string().valid('Market', 'Limit').required(),
  limit_price: Joi.number().min(0).allow(null).default(null),
  amount: Joi.number().min(0).required(),
  executed_price: Joi.number().min(0).allow(null).default(null),
  status: Joi.string().valid('Pending', 'Filled', 'Cancelled').default('Pending'),
  created_at: Joi.date().default(Date.now),
  updated_at: Joi.date().default(Date.now),
});

module.exports = {
  SpotTrade: mongoose.model('SpotTrade', spotTradeSchema),
  validateSpotTrade: (data) => spotTradeValidationSchema.validate(data),
};