// models/FutureTrade.js
const mongoose = require('mongoose');
const Joi = require('joi');

const futureTradeSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  futures_wallet_id: { type: mongoose.Schema.Types.ObjectId, ref: 'FuturesWallet', required: true },
  trading_pair_id: { type: mongoose.Schema.Types.ObjectId, ref: 'TradingPair', required: true },

  // Trading settings
  leverage: { type: Number, required: true, min: 1 },
  position: { type: String, enum: ['Long', 'Short'], required: true },
  margin_type: { type: String, enum: ['Cross', 'Isolated'], required: true },

  // Order
  order_type: { type: String, enum: ['Market', 'Limit'], required: true },
  limit_price: { type: Number, min: 0, default: null },

  // Attached reduce-only triggers (OCO)
  take_profit_price: { type: Number, min: 0, default: null },
  stop_loss_price: { type: Number, min: 0, default: null },

  // Execution
  amount: { type: Number, required: true, min: 0 },
  open_price: { type: Number, min: 0, default: null },
  close_price: { type: Number, min: 0, default: null },
  liquidation_price: { type: Number, min: 0, default: null },

  // State
  status: { type: String, enum: ['Pending', 'Filled', 'Closed', 'Liquidated'], default: 'Pending' },
  pnl: { type: Number, default: 0 },

  // Timestamps
  executed_at: { type: Date, default: null },
  closed_at: { type: Date, default: null },
  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now },
});

futureTradeSchema.pre('save', function(next) {
  this.updated_at = Date.now();
  next();
});

const futureTradeValidationSchema = Joi.object({
  trading_pair_id: Joi.string().required(),
  leverage: Joi.number().min(1).required(),
  position: Joi.string().valid('Long', 'Short').required(),
  margin_type: Joi.string().valid('Cross', 'Isolated').required(),
  order_type: Joi.string().valid('Market', 'Limit').required(),
  limit_price: Joi.number().min(0).allow(null),

  amount: Joi.number().min(0).required(),

  take_profit_price: Joi.number().min(0).allow(null),
  stop_loss_price: Joi.number().min(0).allow(null),
});

module.exports = {
  FutureTrade: mongoose.model('FutureTrade', futureTradeSchema),
  validateFutureTrade: (data) => futureTradeValidationSchema.validate(data),
};
