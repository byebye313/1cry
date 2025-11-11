// models/KycRequest.js
const mongoose = require('mongoose');

const kycRequestSchema = new mongoose.Schema({
  user_id: { type: mongoose.Types.ObjectId, ref: 'User', required: true, index: true },
  front_image_path: { type: String, required: true },
  back_image_path: { type: String, required: true },
  status: { type: String, enum: ['pending','approved','rejected'], default: 'pending', index: true },
  reviewed_by: { type: mongoose.Types.ObjectId, ref: 'User', default: null },
  reviewed_at: { type: Date, default: null },
  reject_reason: { type: String, default: null },
  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now },
});

kycRequestSchema.pre('save', function(next) {
  this.updated_at = new Date();
  next();
});

module.exports = mongoose.models.KycRequest || mongoose.model('KycRequest', kycRequestSchema);
