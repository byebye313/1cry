// models/FuturesWallet.js
const mongoose = require('mongoose');
const Joi = require('joi');

const futuresWalletSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now },
});

futuresWalletSchema.pre('save', function (next) {
  this.updated_at = Date.now();
  next();
});

const futuresWalletValidationSchema = Joi.object({
  user_id: Joi.string().required(),
  created_at: Joi.date().default(Date.now),
  updated_at: Joi.date().default(Date.now),
});

module.exports = {
  FuturesWallet: mongoose.model('FuturesWallet', futuresWalletSchema),
  validateFuturesWallet: (data) => futuresWalletValidationSchema.validate(data),
};
