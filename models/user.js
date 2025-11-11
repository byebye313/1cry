// models/user.js
const mongoose = require('mongoose');
const Joi = require('joi');

const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  email: { type: String, required: true, unique: true, trim: true, lowercase: true },
  password: { type: String, minlength: 8 },
  profile_image: { type: String, default: null },
  role: { type: String, enum: ['User', 'Support'], default: 'User' },
  spot_wallet: { type: String, ref: 'SpotWallet', default: null },
  futures_wallet: { type: String, ref: 'FuturesWallet', default: null },
  ai_wallet: { type: String, ref: 'AIWallet', default: null },
  otp: { type: String },
  otpExpires: { type: Date },
  googleId: { type: String, unique: true, sparse: true },
  xId: { type: String, unique: true, sparse: true },
  referralCode: { type: String, unique: true, required: false }, // رمز إحالة فريد ومطلوب
  referredBy: { type: String, ref: 'User', default: null }, // ربط المستخدم المحال
  pool_group: { type: Number, min:1, max:9, default: null },
  kyc_status: { type: String, enum: ['unverified','pending','verified','rejected'], default: 'unverified' },
  kyc_verified_at: { type: Date, default: null },
  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now }
});

// تحديث updated_at قبل الحفظ
userSchema.pre('save', function(next) {
  this.updated_at = Date.now();
  next();
});

const userValidationSchema = Joi.object({
  username: Joi.string().min(3).max(15).required(),
  email: Joi.string().email().required().trim().lowercase(),
  password: Joi.string().min(8).allow(''),
  profile_image: Joi.string().uri().optional().allow(null),
  role: Joi.string().valid('User', 'Support').default('User'),
  spot_wallet: Joi.string().allow(null).default(null),
  futures_wallet: Joi.string().allow(null).default(null),
  ai_wallet: Joi.string().allow(null).default(null),
  otp: Joi.string().optional(),
  otpExpires: Joi.date().optional(),
  googleId: Joi.string().optional(),
  xId: Joi.string().optional(),
  referralCode: Joi.string(),
  referredBy: Joi.string().allow(null).default(null),
  created_at: Joi.date().default(Date.now),
  updated_at: Joi.date().default(Date.now)
});

const User = mongoose.models.User || mongoose.model('User', userSchema);

module.exports = {
  User,
  validateUser: (data) => userValidationSchema.validate(data)
};