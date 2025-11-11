const mongoose = require('mongoose');
const Joi = require('joi');

const depositSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }, // المستخدم
  spot_wallet_id: { type: mongoose.Schema.Types.ObjectId, ref: 'SpotWallet', required: true }, // المحفظة الفورية
  asset_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Asset', required: true }, // العملة المودعة
  amount: { type: Number, required: true, min: 0 }, // الكمية (غير سالبة)
  status: { type: String, enum: ['Pending', 'Completed', 'Failed'], default: 'Pending' }, // الحالة
  created_at: { type: Date, default: Date.now }, // تاريخ الإنشاء
  updated_at: { type: Date, default: Date.now }, // تاريخ التحديث
});

depositSchema.pre('save', function (next) {
  this.updated_at = Date.now();
  next();
});

const depositValidationSchema = Joi.object({
  amount: Joi.number().min(0).required(),
  status: Joi.string().valid('Pending', 'Completed', 'Failed').default('Pending'),
  created_at: Joi.date().default(Date.now),
  updated_at: Joi.date().default(Date.now),
});

module.exports = {
  Deposit: mongoose.model('Deposit', depositSchema),
  validateDeposit: (data) => depositValidationSchema.validate(data),
};