const mongoose = require('mongoose');


async function getUSDTAssetId() {
// Replace with your actual Asset model import name if different
const Asset = mongoose.models.Asset || mongoose.model('Asset');
const asset = await Asset.findOne({ symbol: 'USDT' }).lean();
if (!asset) throw new Error('USDT asset not found. Please seed Asset collection with USDT.');
return asset._id;
}


module.exports = { getUSDTAssetId };