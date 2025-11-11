const mongoose = require('mongoose');
const { Transfer, validateTransfer } = require('../models/Transfer');
const { SpotWalletBalance } = require('../models/SpotWalletBalance');
const { FuturesWalletBalance } = require('../models/FutureWalletBalance');
const { AIWalletBalance } = require('../models/AI_WalletBalance');
const { Asset } = require('../models/Asset');

// إنشاء تحويل بين المحافظ (USDT فقط)
async function createTransfer(req, res) {
  const { error } = validateTransfer(req.body);
  if (error) return res.status(400).send(error.details[0].message);

  const { user_id, from_wallet_id, to_wallet_id, asset_id, amount } = req.body;

  // التحقق من أن from_wallet_id و to_wallet_id و asset_id هما ObjectId صالحان
  if (!mongoose.Types.ObjectId.isValid(from_wallet_id)) {
    return res.status(400).send('Invalid from_wallet_id: Must be a valid ObjectId');
  }
  if (!mongoose.Types.ObjectId.isValid(to_wallet_id)) {
    return res.status(400).send('Invalid to_wallet_id: Must be a valid ObjectId');
  }
  if (!mongoose.Types.ObjectId.isValid(asset_id)) {
    return res.status(400).send('Invalid asset_id: Must be a valid ObjectId');
  }

  // جلب USDT asset_id للتحقق
  const usdtAsset = await Asset.findOne({ symbol: 'USDT' });
  if (!usdtAsset) return res.status(500).send('USDT asset not found in database');

  // التحقق من أن التحويل يستخدم USDT فقط
  if (asset_id !== usdtAsset._id.toString()) {
    return res.status(400).send('Transfers between all wallets are restricted to USDT only');
  }

  // تحديد نوع المحفظة المرسلة والمستقبلة
  const walletTypes = [
    { type: 'Spot', model: SpotWalletBalance, key: 'spot_wallet_id' },
    { type: 'Futures', model: FuturesWalletBalance, key: 'futures_wallet_id' },
    { type: 'AI', model: AIWalletBalance, key: 'ai_wallet_id' },
  ];

  let fromBalance, toBalance, fromWalletType, toWalletType;

  // البحث عن المحفظة المرسلة
  for (const wallet of walletTypes) {
    if (!fromBalance) {
      fromBalance = await wallet.model.findOne({ [wallet.key]: from_wallet_id, asset_id });
      if (fromBalance) fromWalletType = wallet;
    }
    if (!toBalance) {
      toBalance = await wallet.model.findOne({ [wallet.key]: to_wallet_id, asset_id });
      if (toBalance) toWalletType = wallet;
    }
  }

  // التحقق من وجود المحافظ والرصيد
  if (!fromBalance) {
    return res.status(404).send('From wallet balance not found for USDT');
  }
  if (fromBalance.balance < amount) {
    return res.status(400).send('Insufficient USDT balance in from wallet');
  }
  if (!toBalance) {
    for (const wallet of walletTypes) {
      const exists = await wallet.model.findOne({ [wallet.key]: to_wallet_id });
      if (exists || !toWalletType) {
        toWalletType = wallet;
        break;
      }
    }
    if (!toWalletType) {
      return res.status(404).send('To wallet type not found');
    }
    toBalance = new toWalletType.model({
      [toWalletType.key]: to_wallet_id,
      asset_id: usdtAsset._id,
      balance: 0,
    });
  }

  try {
    // إنشاء سجل التحويل
    const transfer = new Transfer({
      user_id,
      from_wallet_id,
      to_wallet_id,
      asset_id: usdtAsset._id,
      amount,
    });

    // تحديث الأرصدة
    fromBalance.balance -= amount;
    toBalance.balance += amount;

    // حفظ التغييرات بدون معاملة
    await fromBalance.save();
    await toBalance.save();
    await transfer.save();

    res.status(201).send(transfer);
  } catch (err) {
    res.status(500).send(`Error processing transfer: ${err.message}`);
  }
}

// جلب سجل التحويلات للمستخدم
async function getTransferHistory(req, res) {
  const { user_id } = req.params;
  try {
    const transfers = await Transfer.find({ user_id }).populate('asset_id');
    res.status(200).send(transfers);
  } catch (err) {
    res.status(500).send(`Error fetching transfer history: ${err.message}`);
  }
}

module.exports = { createTransfer, getTransferHistory };