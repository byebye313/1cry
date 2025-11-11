const mongoose = require('mongoose');
const Joi = require('joi');

const supportMessageSchema = new mongoose.Schema({
  support_session_id: { type: mongoose.Schema.Types.ObjectId, ref: 'SupportSession', required: true },
  sender_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  message: { type: String, required: true },
  is_canned: { type: Boolean, default: false },
  created_at: { type: Date, default: Date.now },
});

const SupportMessage = mongoose.model('SupportMessage', supportMessageSchema);

function validateSupportMessage(message) {
  const schema = Joi.object({
    support_session_id: Joi.string().required(),
    sender_id: Joi.string().required(),
    message: Joi.string().required(),
    canned_response_id: Joi.string().optional().allow(null), // السماح بـ null صراحةً
    is_canned: Joi.boolean().default(false),
    created_at: Joi.date().default(Date.now).optional(),
  });
  return schema.validate(message);
}

module.exports = { SupportMessage, validateSupportMessage };