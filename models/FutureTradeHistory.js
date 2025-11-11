const mongoose = require('mongoose');

const futuresTradeHistorySchema = new mongoose.Schema({
  future_trade_id:     { type: mongoose.Schema.Types.ObjectId, ref: 'FutureTrade', required: true },
  user_id:             { type: mongoose.Schema.Types.ObjectId, ref: 'User',        required: true },
  trading_pair_id:     { type: mongoose.Schema.Types.ObjectId, ref: 'TradingPair', required: true },
  trading_pair_symbol: { type: String }, // مثال: BTCUSDT لسهولة العرض

  position:  { type: String, enum: ['Long', 'Short'], required: true },
  leverage:  { type: Number, min: 1 },
  margin_type:{ type: String, enum: ['Cross', 'Isolated'] },   // ✅ جديد
  amount:    { type: Number, min: 0, required: true },

  // الأسعار
  open_price:  { type: Number, min: 0 },
  close_price: { type: Number, min: 0 },

  // ربح/خسارة مُحقّقة عند الإغلاق
  pnl: { type: Number, default: 0 },

  // Filled / Closed / Liquidated / Take Profit / Stop Loss / Cancelled
  status: { type: String },

  executed_at: { type: Date, required: true },
  created_at:  { type: Date, default: Date.now },
});

module.exports = {
  FuturesTradeHistory: mongoose.model('FuturesTradeHistory', futuresTradeHistorySchema),
};
