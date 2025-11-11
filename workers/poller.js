const { Deposit } = require('../models/Deposit');
const {SpotWalletBalance} = require('../models/SpotWalletBalance');
const { startEvmWatcher } = require('./evmWatcher');
const { startTronWatcher } = require('./tronWatcher');
const { startUtxoWatcher } = require('./utxoWatcher');
const { startXrpWatcher } = require('./xrpWatcher');
const DepositIntent = require('../models/DepositIntent')
// حلقة اعتماد مبسطة: أي إيداع Pending يصبح Completed وتُضاف قيمته للسبوت
// (يمكنك استبدالها لاحقًا بمنطق التأكيدات الحقيقية لكل شبكة)
async function confirmationsTick() {
  try {
    const pendings = await Deposit.find({ status: 'Pending' }).limit(500);
    for (const dep of pendings) {
      await SpotWalletBalance.updateOne(
        { spot_wallet_id: dep.spot_wallet_id, asset_id: dep.asset_id },
        { $inc: { balance: dep.amount } },
        { upsert: true }
      );
      dep.status = 'Completed';
      await dep.save();
    }
  } catch (e) {
    console.error('confirmationsTick', e.message);
  }
}


async function expireIntents() {
  try {
    const now = new Date();
    // علّم intents المنتهية
    await DepositIntent.updateMany(
      { status: 'Pending', expires_at: { $lte: now } },
      { $set: { status: 'Expired' } }
    );

    // تنظيف اختياري: احذف intents Expired الأقدم من 7 أيام
    const sevenDaysAgo = new Date(Date.now() - 7*24*60*60*1000);
    await DepositIntent.deleteMany({ status: 'Expired', updatedAt: { $lt: sevenDaysAgo } });
  } catch (e) {
    console.error('expireIntents error', e.message);
  }
}

// داخل startAllWatchers():
function startAllWatchers() {
  startEvmWatcher();
  startTronWatcher();
  startUtxoWatcher();
  startXrpWatcher();

  const interval = Number(process.env.CONFIRM_INTERVAL_MS || 20000);
  setInterval(confirmationsTick, interval);

  // شغّل فحص الانتهاء كل 60 ثانية
  setInterval(expireIntents, 60 * 1000);

  console.log('Confirmations + Expiry loops started');
}


module.exports = { startAllWatchers };
