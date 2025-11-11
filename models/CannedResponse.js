const mongoose = require('mongoose');
const Joi = require('joi');

const cannedResponseSchema = new mongoose.Schema({
  title: { type: String, required: true },
  message: { type: String, required: true },
  created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  created_at: { type: Date, default: Date.now },
});

const CannedResponse = mongoose.model('CannedResponse', cannedResponseSchema);

function validateCannedResponse(response) {
  const schema = Joi.object({
    title: Joi.string().required(),
    message: Joi.string().required(),
    created_by: Joi.string().required(),
    created_at: Joi.date().default(Date.now).optional(),
  });
  return schema.validate(response);
}

module.exports = { CannedResponse, validateCannedResponse };