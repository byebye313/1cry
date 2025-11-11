const mongoose = require('mongoose');
const { PROMOTION_TYPES, PROMOTION_PLATFORMS } = require('../constants/promotion');
const Joi = require('joi');

const promotionVideoSchema = new mongoose.Schema({
user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
type: { type: String, enum: Object.values(PROMOTION_TYPES), required: true, index: true },
platform: { type: String, enum: PROMOTION_PLATFORMS, required: true },


// Anti-fraud: keep a normalized version for uniqueness
video_url: { type: String, required: true, trim: true },
normalized_video_url: { type: String, unique: true, sparse: true, index: true },


// Local file storage
screenshot_path: { type: String, required: true, trim: true },
screenshot_original_name: { type: String, required: true, trim: true },


description_text: { type: String, required: true, trim: true },


status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending', index: true },
review_reason: { type: String, default: null },
reviewed_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
reviewed_at: { type: Date, default: null },


reward_usdt: { type: Number, default: 0 },
reward_tx_id: { type: mongoose.Schema.Types.ObjectId, ref: 'WalletTransaction', default: null },


// Future metrics (can be edited by Support later)
views_count: { type: Number, default: 0 },
likes_count: { type: Number, default: 0 },


created_at: { type: Date, default: Date.now },
updated_at: { type: Date, default: Date.now },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });


promotionVideoSchema.index({ user_id: 1, type: 1, status: 1, created_at: -1 });


// Normalize URL before save
promotionVideoSchema.pre('save', function normalize(next) {
if (this.isModified('video_url')) {
const url = String(this.video_url || '').trim().toLowerCase();
this.normalized_video_url = url;
}
next();
});


const createPromotionVideoValidation = Joi.object({
type: Joi.string().valid(...Object.values(PROMOTION_TYPES)).required(),
platform: Joi.string().valid(...PROMOTION_PLATFORMS).required(),
video_url: Joi.string().uri().required(),
description_text: Joi.string().min(10).required(),
// screenshot via multipart form => file is required by multer
});


const reviewPromotionVideoValidation = Joi.object({
status: Joi.string().valid('approved', 'rejected').required(),
review_reason: Joi.string().allow('', null),
});


const patchMetricsValidation = Joi.object({
views_count: Joi.number().integer().min(0),
likes_count: Joi.number().integer().min(0),
});


module.exports = {
PromotionVideo: mongoose.model('PromotionVideo', promotionVideoSchema),
validateCreatePromotionVideo: (payload) => createPromotionVideoValidation.validate(payload),
validateReviewPromotionVideo: (payload) => reviewPromotionVideoValidation.validate(payload),
validatePatchMetrics: (payload) => patchMetricsValidation.validate(payload),
};