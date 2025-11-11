const mongoose = require('mongoose');
const Joi = require('joi');

const tradingPairSchema = new mongoose.Schema({
  base_asset_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Asset', required: true }, // العملة الأساسية
  quote_asset_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Asset', required: true }, // العملة المقابلة (USDT)
  symbol: { type: String, required: true, unique: true, trim: true }, // الرمز (مثل BTCUSDT)
  created_at: { type: Date, default: Date.now }, // تاريخ الإنشاء
  updated_at: { type: Date, default: Date.now }, // تاريخ التحديث
});

tradingPairSchema.pre('save', function (next) {
  this.updated_at = Date.now();
  next();
});

const tradingPairValidationSchema = Joi.object({
  base_asset_id: Joi.string().required(),
  quote_asset_id: Joi.string().required(),
  symbol: Joi.string().required().trim(),
  created_at: Joi.date().default(Date.now),
  updated_at: Joi.date().default(Date.now),
});

module.exports = {
  TradingPair: mongoose.model('TradingPair', tradingPairSchema),
  validateTradingPair: (data) => tradingPairValidationSchema.validate(data),
};