const mongoose = require('mongoose');
const Joi = require('joi');


const supportRequestSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  subject: { type: String, required: true },
  description: { type: String, required: true },
  initial_message: { type: String, required: true },
  status: { type: String, enum: ['Open', 'Accepted', 'Resolved'], default: 'Open' },
  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now },
});

supportRequestSchema.pre('save', function (next) {
  this.updated_at = Date.now();
  next();
});

const supportRequestValidationSchema = Joi.object({
  user_id: Joi.string().required(),
  subject: Joi.string().required(),
  description: Joi.string().required(),
  initial_message: Joi.string().required(),
  status: Joi.string().valid('Open', 'Accepted', 'Resolved').default('Open'),
  created_at: Joi.date().default(Date.now),
  updated_at: Joi.date().default(Date.now),
});


module.exports = {
  SupportRequest: mongoose.model('SupportRequest', supportRequestSchema),
  validateSupportRequest: (data) => supportRequestValidationSchema.validate(data),
};