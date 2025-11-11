const mongoose = require('mongoose');
const Joi = require('joi');

const notificationSchema = new mongoose.Schema({
  user_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  type: {
    type: String,
    enum: ['Deposit', 'Withdrawal', 'Transfer', 'SpotTrade', 'FutureTrade', 'AITrade', 'Referral', 'Support', 'Other', 'PredictionPayment', 'Promotion'],
    required: true
  },
  title: {
    type: String,
    required: true
  },
  message: {
    type: String,
    required: true
  },
  is_read: {
    type: Boolean,
    default: false
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
notificationSchema.pre('save', function(next) {
  this.updated_at = Date.now();
  next();
});

const notificationValidationSchema = Joi.object({
  user_id: Joi.string().required().messages({
    'string.empty': 'معرف المستخدم مطلوب',
    'any.required': 'معرف المستخدم مطلوب'
  }),
  type: Joi.string()
    .valid('Deposit', 'Withdrawal', 'Transfer', 'SpotTrade', 'FutureTrade', 'AITrade', 'Referral', 'Support', 'Other' , 'PredictionPayment')
    .required()
    .messages({
      'string.empty': 'نوع الإشعار مطلوب',
      'any.required': 'نوع الإشعار مطلوب',
      'any.only': 'نوع الإشعار غير صالح'
    }),
  title: Joi.string().required().messages({
    'string.empty': 'عنوان الإشعار مطلوب',
    'any.required': 'عنوان الإشعار مطلوب'
  }),
  message: Joi.string().required().messages({
    'string.empty': 'نص الإشعار مطلوب',
    'any.required': 'نص الإشعار مطلوب'
  }),
  is_read: Joi.boolean().default(false),
  created_at: Joi.date().default(Date.now),
  updated_at: Joi.date().default(Date.now)
});

module.exports = {
  Notification: mongoose.model('Notification', notificationSchema),
  validateNotification: (data) => notificationValidationSchema.validate(data)
};