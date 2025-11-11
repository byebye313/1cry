const mongoose = require('mongoose');
const Joi = require('joi');
const { v4: uuidv4 } = require('uuid');

const orderBookSchema = new mongoose.Schema({
  trading_pair_id: { type: mongoose.Schema.Types.ObjectId, ref: 'TradingPair', required: true }, // زوج التداول
  trade_id: { type: String , required: true }, // يشير إلى SpotTrade أو FutureTrade
  trade_type: { type: String, enum: ['Buy', 'Sell'], required: true }, // نوع التداول
  order_type: { type: String, enum: ['Spot', 'Futures'], required: true }, // نوع الأمر
  price: { type: Number, required: true, min: 0 }, // السعر المحدد
  amount: { type: Number, required: true, min: 0 }, // الكمية
  status: { type: String, enum: ['Pending', 'Filled', 'Cancelled'], default: 'Pending' }, // الحالة
  created_at: { type: Date, default: Date.now }, // تاريخ الإنشاء
  updated_at: { type: Date, default: Date.now }, // تاريخ التحديث
});

orderBookSchema.pre('save', function (next) {
  this.updated_at = Date.now();
  next();
});

const orderBookValidationSchema = Joi.object({
  trading_pair_id: Joi.string().required(),
  trade_id: Joi.string().required(),
  trade_type: Joi.string().valid('Buy', 'Sell').required(),
  order_type: Joi.string().valid('Spot', 'Futures').required(),
  price: Joi.number().min(0).required(),
  amount: Joi.number().min(0).required(),
  status: Joi.string().valid('Pending', 'Filled', 'Cancelled').default('Pending'),
  created_at: Joi.date().default(Date.now),
  updated_at: Joi.date().default(Date.now),
});

module.exports = {
  OrderBook: mongoose.model('OrderBook', orderBookSchema),
  validateOrderBook: (data) => orderBookValidationSchema.validate(data),
};