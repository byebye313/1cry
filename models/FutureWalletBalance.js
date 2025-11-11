// models/FuturesWalletBalance.js
const mongoose = require('mongoose');
const Joi = require('joi');

const futuresWalletBalanceSchema = new mongoose.Schema({
  futures_wallet_id: { type: mongoose.Schema.Types.ObjectId, ref: 'FuturesWallet', required: true },
  asset_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Asset', required: true }, // USDT now
  balance: { type: Number, default: 0, min: 0 },
  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now },
});

futuresWalletBalanceSchema.pre('save', function (next) {
  this.updated_at = Date.now();
  next();
});

const futuresWalletBalanceValidationSchema = Joi.object({
  balance: Joi.number().min(0).default(0),
  created_at: Joi.date().default(Date.now),
  updated_at: Joi.date().default(Date.now),
});

module.exports = {
  FuturesWalletBalance: mongoose.model('FuturesWalletBalance', futuresWalletBalanceSchema),
  validateFuturesWalletBalance: (data) => futuresWalletBalanceValidationSchema.validate(data),
};
