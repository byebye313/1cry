const mongoose = require('mongoose');

const depositIntentSchema = new mongoose.Schema({
  user_id:        { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  spot_wallet_id: { type: mongoose.Schema.Types.ObjectId, ref: 'SpotWallet', required: true },
  pool_group:     { type: Number, min:1, max:9, required: true },

  asset_symbol:   { type: String, required: true },    // 'USDT','BTC',...
  network_name:   { type: String, required: true },    // 'Tron TRC-20','BEP-20','Bitcoin','Ripple',...
  deposit_address:{ type: String, required: true },

  expected_amount:{ type: String, required: true },
  memo_tag:       { type: String },                    // للـXRP
  expires_at:     { type: Date, required: true },

  status:         { type: String, enum: ['Pending','Matched','Expired','Canceled'], default: 'Pending' },
  matched_tx_hash:{ type: String },
  matched_block_number: { type: Number },
  matched_at:     { type: Date }
}, { timestamps: true });

depositIntentSchema.index({ deposit_address:1, expected_amount:1, memo_tag:1, status:1 });

module.exports = mongoose.model('DepositIntent', depositIntentSchema);
