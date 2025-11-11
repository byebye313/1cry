const mongoose = require('mongoose');
const Joi = require('joi');
const Schema = mongoose.Schema;

const luckWheelSpinSchema = new Schema({
    user_id: {
        type: Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    spot_wallet_id: {
        type: Schema.Types.ObjectId,
        ref: 'SpotWallet',
        required: true
    },
    reward_percentage: {
        type: Number,
        enum: [1, 3, 5, 7, 10, 100],
        required: true
    },
    reward_amount: {
        type: Number,
        required: true,
        min: 0
    },
    spin_date: {
        type: Date,
        required: true,
        default: () => new Date().setHours(0, 0, 0, 0) // Reset to start of day
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

// Index to enforce one spin per day per user
luckWheelSpinSchema.index({ user_id: 1, spin_date: 1 }, { unique: true });

const LuckWheelSpin = mongoose.model('LuckWheelSpin', luckWheelSpinSchema);

const validateLuckWheelSpin = (data) => {
  const schema = Joi.object({
    user_id: Joi.string().required(),
    spot_wallet_id: Joi.string().required()
  });
  return schema.validate(data);
};

module.exports = { LuckWheelSpin, validateLuckWheelSpin };
module.exports = { LuckWheelSpin, validateLuckWheelSpin };