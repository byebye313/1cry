const mongoose = require('mongoose');
const Joi = require('joi');

const aiWalletBalanceSchema = new mongoose.Schema({
  ai_wallet_id: { type: mongoose.Schema.Types.ObjectId, ref: 'AIWallet', required: true }, // محفظة الذكاء الاصطناعي
  asset_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Asset', required: true }, // العملة
  balance: { type: Number, default: 0, min: 0 }, // الرصيد (غير سالب)
  created_at: { type: Date, default: Date.now }, // تاريخ الإنشاء
  updated_at: { type: Date, default: Date.now }, // تاريخ التحديث
});

aiWalletBalanceSchema.pre('save', function (next) {
  this.updated_at = Date.now();
  next();
});

const aiWalletBalanceValidationSchema = Joi.object({
  balance: Joi.number().min(0).default(0),
  created_at: Joi.date().default(Date.now),
  updated_at: Joi.date().default(Date.now),
});

module.exports = {
  AIWalletBalance: mongoose.model('AIWalletBalance', aiWalletBalanceSchema),
  validateAIWalletBalance: (data) => aiWalletBalanceValidationSchema.validate(data),
};