const mongoose = require('mongoose');
const { SpotWallet } = require('../models/SpotWallet');
const { SpotWalletBalance } = require('../models/SpotWalletBalance');
const { getUSDTAssetId } = require('../utils/getUSDTAssetId');


async function ensureSpotWallet(userId, session) {
let spotWallet = await SpotWallet.findOne({ user_id: userId }).session(session);
if (!spotWallet) {
const created = await SpotWallet.create([{ user_id: userId }], { session });
spotWallet = created[0];
}
return spotWallet;
}


async function creditSpotUSDT(userId, amount, session) {
if (!(amount > 0)) throw new Error('Invalid credit amount');


const usdtAssetId = await getUSDTAssetId();
const spotWallet = await ensureSpotWallet(userId, session);


let bal = await SpotWalletBalance.findOne({
spot_wallet_id: spotWallet._id,
asset_id: usdtAssetId,
}).session(session);


if (!bal) {
const created = await SpotWalletBalance.create([
{ spot_wallet_id: spotWallet._id, asset_id: usdtAssetId, balance: 0 },
], { session });
bal = created[0];
}


bal.balance += amount;
await bal.save({ session });


return { spotWalletId: spotWallet._id, balanceId: bal._id, newBalance: bal.balance };
}


async function getSpotUSDTBalance(userId) {
const usdtAssetId = await getUSDTAssetId();
const spotWallet = await SpotWallet.findOne({ user_id: userId });
if (!spotWallet) return 0;
const bal = await SpotWalletBalance.findOne({ spot_wallet_id: spotWallet._id, asset_id: usdtAssetId }).lean();
return Number(bal?.balance || 0);
}


module.exports = { creditSpotUSDT, getSpotUSDTBalance };