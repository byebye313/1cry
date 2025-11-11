const mongoose = require('mongoose');
const Joi = require('joi');

const supportSessionSchema = new mongoose.Schema({
  support_request_id: { type: mongoose.Schema.Types.ObjectId, ref: 'SupportRequest', required: true },
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  support_staff_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  status: { type: String, enum: ['Active', 'Closed'], default: 'Active' },
  rating: { type: Number, min: 1, max: 5, default: null },
  created_at: { type: Date, default: Date.now },
});

const SupportSession = mongoose.model('SupportSession', supportSessionSchema);

function validateSupportSession(session) {
  const schema = Joi.object({
    support_request_id: Joi.string().required(),
    user_id: Joi.string().required(),
    support_staff_id: Joi.string().required(),
    status: Joi.string().valid('Active', 'Closed').default('Active'),
    rating: Joi.number().min(1).max(5).optional(),
    created_at: Joi.date().default(Date.now).optional(),
  });
  return schema.validate(session);
}

module.exports = { SupportSession, validateSupportSession };