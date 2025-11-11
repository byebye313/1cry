// models/WithdrawalRequest.js
const mongoose = require('mongoose');
const Joi = require('joi');

const withdrawalRequestSchema = new mongoose.Schema({
  user_id:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  asset_symbol:  { type: String, required: true },          // USDT, BTC, LTC, ...
  network:       { type: String, required: true },          // TRC20, ERC20, BTC, ...
  to_address:    { type: String, required: true, trim: true },
  amount:        { type: Number, required: true, min: 0.00000001 },

  // ===== رسوم/سعر (جديدة) =====
  price_usdt:           { type: Number, default: 0 },       // سعر الأصل مقابل USDT لحظة الطلب
  platform_fee_usdt:    { type: Number, default: 5 },       // ثابت 5 USDT
  platform_fee_asset:   { type: Number, default: 0 },       // تحويل الـ 5 USDT إلى أصل السحب
  network_fee_pct:      { type: Number, default: 0 },       // 0 لـ USDT، 0.01 لغيره
  network_fee_asset:    { type: Number, default: 0 },       // amount * pct (لغير USDT)
  total_fee_asset:      { type: Number, default: 0 },       // platform + network
  net_amount:           { type: Number, default: 0 },       // amount - total_fee_asset

  // ===== حقول قديمة/متروكة (مسموح بوجودها للتوافق) =====
  fee_usdt:             { type: Number, default: undefined },
  fee_asset:            { type: Number, default: undefined },

  status:        { type: String, enum: ['Pending','Approved','Rejected','Completed'], default: 'Pending' },
  // txid:        { type: String, default: null },          // ملغي حسب طلبك
  reject_reason: { type: String, default: null },
  history_notes: [{ note: String, at: { type: Date, default: Date.now } }],

  created_at:    { type: Date, default: Date.now },
  updated_at:    { type: Date, default: Date.now },
}, { strict: true });

withdrawalRequestSchema.pre('save', function(next){
  this.updated_at = Date.now();
  next();
});

const WithdrawalRequest = mongoose.model('WithdrawalRequest', withdrawalRequestSchema);

const createWithdrawalValidation = Joi.object({
  asset_symbol: Joi.string().uppercase().required(),
  network: Joi.string().required(),
  to_address: Joi.string().trim().required(),
  amount: Joi.number().positive().required(),
});

module.exports = {
  WithdrawalRequest,
  validateCreateWithdrawal: (payload) => createWithdrawalValidation.validate(payload),
};
