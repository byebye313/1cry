const mongoose = require('mongoose');
const Joi = require('joi');

const aiWalletSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true }, // مستخدم واحد = محفظة واحدة
  created_at: { type: Date, default: Date.now }, // تاريخ الإنشاء
  updated_at: { type: Date, default: Date.now }, // تاريخ التحديث
});

aiWalletSchema.pre('save', function (next) {
  this.updated_at = Date.now();
  next();
});

const aiWalletValidationSchema = Joi.object({
  created_at: Joi.date().default(Date.now),
  updated_at: Joi.date().default(Date.now),
});

module.exports = {
  AIWallet: mongoose.model('AIWallet', aiWalletSchema),
  validateAIWallet: (data) => aiWalletValidationSchema.validate(data),
};