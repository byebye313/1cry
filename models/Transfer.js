const mongoose = require('mongoose');
const Joi = require('joi');

const transferSchema = new mongoose.Schema({
  user_id: { type: String, ref: 'User', required: true }, // المستخدم
  from_wallet_id: { type: String, required: true }, // المحفظة المرسلة
  to_wallet_id: { type: String, required: true }, // المحفظة المستقبلة
  asset_id: { type: String, ref: 'Asset', required: true }, // العملة
  amount: { type: Number, required: true, min: 0 }, // الكمية (غير سالبة)
  created_at: { type: Date, default: Date.now }, // تاريخ الإنشاء
  updated_at: { type: Date, default: Date.now }, // تاريخ التحديث
});

transferSchema.pre('save', function (next) {
  this.updated_at = Date.now();
  next();
});

const transferValidationSchema = Joi.object({
  user_id: Joi.string().required(),
  from_wallet_id: Joi.string().required(),
  to_wallet_id: Joi.string().required(),
  asset_id: Joi.string().required(),
  amount: Joi.number().min(0).required(),
  created_at: Joi.date().default(Date.now),
  updated_at: Joi.date().default(Date.now),
});

module.exports = {
  Transfer: mongoose.model('Transfer', transferSchema),
  validateTransfer: (data) => transferValidationSchema.validate(data),
};