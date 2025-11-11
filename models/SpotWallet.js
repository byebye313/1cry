const mongoose = require('mongoose');
const Joi = require('joi');

const spotWalletSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true }, // مستخدم واحد = محفظة واحدة
  created_at: { type: Date, default: Date.now }, // تاريخ الإنشاء
  updated_at: { type: Date, default: Date.now }, // تاريخ التحديث
});

spotWalletSchema.pre('save', function (next) {
  this.updated_at = Date.now();
  next();
});

const spotWalletValidationSchema = Joi.object({
  created_at: Joi.date().default(Date.now),
  updated_at: Joi.date().default(Date.now),
});

module.exports = {
  SpotWallet: mongoose.model('SpotWallet', spotWalletSchema),
  validateSpotWallet: (data) => spotWalletValidationSchema.validate(data),
};