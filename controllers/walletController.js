const {SpotWallet} = require('../models/SpotWallet');
const {FuturesWallet} = require('../models/FutureWallet');
const {AIWallet} = require('../models/AI_Wallet');

// جلب معرفات المحافظ للمستخدم
async function getWalletIds(req, res) {
  const { user_id } = req.params;

  try {
    // جلب المحافظ بناءً على user_id
    const spotWallet = await SpotWallet.findOne({ user_id });
    const futuresWallet = await FuturesWallet.findOne({ user_id });
    const aiWallet = await AIWallet.findOne({ user_id });

    // إذا لم تكن المحفظة موجودة، يمكن إنشاؤها (اختياري)
    if (!spotWallet) {
      const newSpotWallet = new SpotWallet({ user_id });
      await newSpotWallet.save();
      spotWallet = newSpotWallet;
    }
    if (!futuresWallet) {
      const newFuturesWallet = new FuturesWallet({ user_id });
      await newFuturesWallet.save();
      futuresWallet = newFuturesWallet;
    }
    if (!aiWallet) {
      const newAIWallet = new AIWallet({ user_id });
      await newAIWallet.save();
      aiWallet = newAIWallet;
    }

    const walletIds = {
      spotWalletId: spotWallet ? spotWallet._id.toString() : null,
      futuresWalletId: futuresWallet ? futuresWallet._id.toString() : null,
      aiWalletId: aiWallet ? aiWallet._id.toString() : null,
    };

    res.status(200).send(walletIds);
  } catch (err) {
    res.status(500).send(`Error fetching wallet IDs: ${err.message}`);
  }
}

module.exports = { getWalletIds };