const mongoose = require('mongoose');
const Joi = require('joi');

const spotWalletBalanceSchema = new mongoose.Schema({
  spot_wallet_id: { type: mongoose.Schema.Types.ObjectId, ref: 'SpotWallet', required: true }, // المحفظة الفورية
  asset_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Asset', required: true }, // العملة
  balance: { type: Number, default: 0, min: 0 }, // الرصيد (غير سالب)
  created_at: { type: Date, default: Date.now }, // تاريخ الإنشاء
  updated_at: { type: Date, default: Date.now }, // تاريخ التحديث
});

spotWalletBalanceSchema.pre('save', function (next) {
  this.updated_at = Date.now();
  next();
});

const spotWalletBalanceValidationSchema = Joi.object({
  balance: Joi.number().min(0).default(0),
  created_at: Joi.date().default(Date.now),
  updated_at: Joi.date().default(Date.now),
});

module.exports = {
  SpotWalletBalance: mongoose.model('SpotWalletBalance', spotWalletBalanceSchema),
  validateSpotWalletBalance: (data) => spotWalletBalanceValidationSchema.validate(data),
};