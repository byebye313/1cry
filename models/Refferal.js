const mongoose = require('mongoose');
const Joi = require('joi');

const referralSchema = new mongoose.Schema({
  referrer_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  referred_user_id: {
    type:  mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  status: {
    type: String,
    enum: ['Pending', 'Eligible', 'Completed'],
    default: 'Pending'
  },
  trade_met: {
    type: Boolean,
    default: false
  },
  trade_amount: {
    type: Number,
    default: 0, // تتبع قيمة التداول
    min: 0
  },
  min_trade_amount: {
    type: Number,
    default: 50 // الحد الأدنى للتداول 50 USDT
  },
  reward_amount: {
    type: Number,
    default: null // 1000, 5000, أو 10000 USDT
  },
  created_at: {
    type: Date,
    default: Date.now
  },
  updated_at: {
    type: Date,
    default: Date.now
  }
});

// تحديث updated_at قبل الحفظ
referralSchema.pre('save', function(next) {
  this.updated_at = Date.now();
  next();
});

const referralValidationSchema = Joi.object({
  referrer_id: Joi.required().messages({
    'string.empty': 'Refferal Code Is Required',
    'any.required': 'Refferal Code Is Required'
  }),
  referred_user_id: Joi.required().messages({
    'string.empty': 'USER Id Is Required',
    'any.required': 'USER Id Is Required'
  }),
  status: Joi.string().valid('Pending', 'Eligible', 'Completed').default('Pending'),
  trade_met: Joi.boolean().default(false),
  trade_amount: Joi.number().min(0).default(0),
  min_trade_amount: Joi.number().min(50).default(50),
  reward_amount: Joi.number().allow(null).default(null),
  created_at: Joi.date().default(Date.now),
  updated_at: Joi.date().default(Date.now)
});

module.exports = {
  Referral: mongoose.model('Referral', referralSchema),
  validateReferral: (data) => referralValidationSchema.validate(data)
};