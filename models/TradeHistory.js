const mongoose = require('mongoose');
const Joi = require('joi');

const tradeHistorySchema = new mongoose.Schema({
  spot_trade_id: { type: mongoose.Schema.Types.ObjectId, ref: 'SpotTrade', required: true }, // الأمر الفوري
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }, // المستخدم
  trading_pair_id: { type: mongoose.Schema.Types.ObjectId, ref: 'TradingPair', required: true }, // زوج التداول
  price: { type: Number, required: true, min: 0 }, // سعر التنفيذ
  amount: { type: Number, required: true, min: 0 }, // الكمية المنفذة
  fee: { type: Number, default: 0, min: 0 }, // الرسوم الداخلية
  trade_type: { type: String, enum: ['Buy', 'Sell'], required: true }, // نوع التداول
  executed_at: { type: Date, required: true }, // وقت التنفيذ
  created_at: { type: Date, default: Date.now }, // تاريخ الإنشاء
});

tradeHistorySchema.pre('save', function (next) {
  this.created_at = Date.now();
  next();
});

const tradeHistoryValidationSchema = Joi.object({
  spot_trade_id: Joi.string().required(),
  user_id: Joi.string().required(),
  trading_pair_id: Joi.string().required(),
  price: Joi.number().min(0).required(),
  amount: Joi.number().min(0).required(),
  fee: Joi.number().min(0).default(0),
  trade_type: Joi.string().valid('Buy', 'Sell').required(),
  executed_at: Joi.date().required(),
  created_at: Joi.date().default(Date.now),
});

module.exports = {
  TradeHistory: mongoose.model('TradeHistory', tradeHistorySchema),
  validateTradeHistory: (data) => tradeHistoryValidationSchema.validate(data),
};