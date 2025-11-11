const mongoose = require('mongoose');
const Joi = require('joi');

const assetSchema = new mongoose.Schema({
  symbol: { type: String, required: true, unique: true, trim: true }, // رمز العملة (مثل BTC)
  name: { type: String, required: true, trim: true }, // الاسم (مثل Bitcoin)
  is_deposit_enabled: { type: Boolean, default: true }, // هل متاح للإيداع؟
  created_at: { type: Date, default: Date.now }, // تاريخ الإنشاء
  updated_at: { type: Date, default: Date.now }, // تاريخ التحديث
});

assetSchema.pre('save', function (next) {
  this.updated_at = Date.now();
  next();
});

const assetValidationSchema = Joi.object({
  symbol: Joi.string().required().trim(),
  name: Joi.string().required().trim(),
  is_deposit_enabled: Joi.boolean().default(true),
  created_at: Joi.date().default(Date.now),
  updated_at: Joi.date().default(Date.now),
});

module.exports = {
  Asset: mongoose.model('Asset', assetSchema),
  validateAsset: (data) => assetValidationSchema.validate(data),
};