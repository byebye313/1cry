// models/AI_Trade.js
const mongoose = require('mongoose');
const Joi = require('joi');

const aiTradeSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  ai_wallet_id: { type: mongoose.Schema.Types.ObjectId, ref: 'AIWallet', required: true },
  trading_pair_id: { type: String, default: 'BTCUSDT', required: true },
  strategy: { type: String, required: true },
  investment: { type: Number, required: true, min: 0 },
  leverage: { type: Number, required: true, min: 1, max: 100 },
  predicted_price: { type: Number, required: true },
  entry_price: { type: Number, required: true },
  trade_type: { type: String, enum: ['Manual', 'Automated'], required: true },
  trade_direction: { type: String, enum: ['Long', 'Short'], required: true },
  total_trades: { type: Number, default: 1, min: 1 },
  remaining_trades: { type: Number, default: 0, min: 0 },
  profit_loss: { type: Number, default: 0 },
  status: { type: String, enum: ['Active', 'Completed', 'Stopped'], default: 'Active' },
  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now },
  margin_type: { type: String, default: 'Cross' },

  // الضرائب (عند الربح فقط)
  tax_rate: { type: Number, default: 0 },     // 0.5 => 50%
  tax_amount: { type: Number, default: 0 },
  net_profit: { type: Number, default: 0 },

  // التصفية
  liquidation_price: { type: Number, default: 0 },
  liquidated: { type: Boolean, default: false },
  liquidation_reason: { type: String, enum: ['HitLiquidation', 'Manual', 'OppositeSignal', 'Target'], default: 'Manual' },
});

aiTradeSchema.pre('save', function (next) {
  this.updated_at = Date.now();
  next();
});

const aiTradeValidationSchema = Joi.object({
  user_id: Joi.string().required(),
  ai_wallet_id: Joi.string().required(),
  entry_price: Joi.number().required(),
  trading_pair_id: Joi.string().default('BTCUSDT'),
  strategy: Joi.string().required(),
  investment: Joi.number().min(0).required(),
  leverage: Joi.number().min(1).max(100).required(),
  predicted_price: Joi.number().required(),
  trade_type: Joi.string().valid('Manual', 'Automated').required(),
  trade_direction: Joi.string().valid('Long', 'Short').required(),
  total_trades: Joi.number().min(1).default(1),
  remaining_trades: Joi.number().min(0).default(0),
  profit_loss: Joi.number().default(0),
  status: Joi.string().valid('Active', 'Completed', 'Stopped').default('Active'),
  created_at: Joi.date().default(Date.now),
  updated_at: Joi.date().default(Date.now),
  margin_type: Joi.string().default('Cross'),

  tax_rate: Joi.number().default(0),
  tax_amount: Joi.number().default(0),
  net_profit: Joi.number().default(0),

  liquidation_price: Joi.number().default(0),
  liquidated: Joi.boolean().default(false),
  liquidation_reason: Joi.string().valid('HitLiquidation', 'Manual', 'OppositeSignal', 'Target').default('Manual'),
});

module.exports = {
  AITrade: mongoose.model('AITrade', aiTradeSchema),
  validateAITrade: (data) => aiTradeValidationSchema.validate(data),
};
