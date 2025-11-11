// models/SupportPrediction.js
const mongoose = require('mongoose');

const supportPredictionSchema = new mongoose.Schema({
  value: { type: Number, required: true },
  window_start: { type: Date, required: true, index: true },
  window_end: { type: Date, required: true, index: true },
  source: { type: String, enum: ['support', 'server'], default: 'support' },
  created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now },
});

supportPredictionSchema.index({ window_start: 1, window_end: 1 }, { unique: true });

supportPredictionSchema.pre('save', function (next) {
  this.updated_at = Date.now();
  next();
});

module.exports = {
  SupportPrediction: mongoose.model('SupportPrediction', supportPredictionSchema),
};
