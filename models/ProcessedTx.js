const mongoose = require('mongoose');

const processedTxSchema = new mongoose.Schema({
  tx_hash:    { type: String, required: true, unique: true },
  address:    { type: String, required: true },
  network_key:{ type: String, required: true } // evm_eth, evm_bsc, tron, btc, ltc, bch, dash, doge, xrp
}, { timestamps: true });

module.exports = mongoose.model('ProcessedTx', processedTxSchema);
