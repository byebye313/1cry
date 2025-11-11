const express = require('express');
const { SpotWallet } = require('../models/SpotWallet');
const { FuturesWallet } = require('../models/FutureWallet');
const { AIWallet } = require('../models/AI_Wallet');
const { Asset } = require('../models/Asset');
const { SpotWalletBalance } = require('../models/SpotWalletBalance');
const { FuturesWalletBalance } = require('../models/FutureWalletBalance');
const { AIWalletBalance } = require('../models/AI_WalletBalance');
const { User } = require('../models/user');
const authMiddleware = require('../middlewares/authMiddleware');
const router = express.Router();
const { getWalletIds } = require('./../controllers/walletController');
const { Deposit } = require('../models/Deposit');
const DepositIntent = require('../models/DepositIntent'); // <-- كان ناقص
const { getPoolCount, findAddressByPool, normalizeNetworkName } = require('../helpers/walletPoolHelper');
const { addFingerprint } = require('../helpers/amount');

// التحقق من وجود محفظة Spot
router.get('/check-wallet', authMiddleware, async (req, res) => {
  try {
    const wallet = await SpotWallet.findOne({ user_id: req.user.id });
    if (!wallet) return res.json({ status: false, message: "You don't have a Spot Wallet yet." });
    res.json({ status: true, message: "Wallet found." });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// تهيئة المحافظ + تعيين pool_group دوري
router.post('/initialize-wallet', authMiddleware, async (req, res) => {
  try {
    const me = await User.findById(req.user.id);

    // تحقّق من عدد مجموعات المحافظ (من wallet.js)
    const totalPools = getPoolCount();
    if (!totalPools || totalPools < 1) {
      return res.status(500).json({ message: 'No pools configured. Ensure wallet.js exports { wallets: [...] } with 9 pools.' });
    }

    const existingSpotWallet = await SpotWallet.findOne({ user_id: req.user.id });

    // لو عنده محفظة سابقة لكن pool_group = null => نُسند فقط الـ pool_group ونكمل
    if (existingSpotWallet) {
      if (!me?.pool_group) {
        // احسب رقم المجموعة التالي (اعتمد عدد من لديهم pool_group بالفعل)
        const assignedCount = await User.countDocuments({ pool_group: { $ne: null } });
        const pool_group = (assignedCount % totalPools) + 1;

        await User.findByIdAndUpdate(req.user.id, { pool_group });
      }
      return res.json({ message: "Wallets already exist. Ensured pool_group is set." });
    }

    // -------------------------
    // في حالة لا توجد محافظ: أنشئ المحافظ كالعادة
    // -------------------------
    const spotWallet = new SpotWallet({ user_id: req.user.id });
    const futuresWallet = new FuturesWallet({ user_id: req.user.id });
    const aiWallet = new AIWallet({ user_id: req.user.id });
    await Promise.all([spotWallet.save(), futuresWallet.save(), aiWallet.save()]);

    // إنشاء أرصدة Spot لكل الأصول الموجودة (إن وُجدت)
    const assets = await Asset.find({});
    if (assets.length) {
      const spotBalances = assets.map((asset) => ({
        spot_wallet_id: spotWallet._id,
        asset_id: asset._id,
        balance: 0
      }));
      await SpotWalletBalance.insertMany(spotBalances);
    }

    // تأكد وجود USDT لأرصدة Futures/AI
    let usdtAsset = await Asset.findOne({ symbol: 'USDT' });
    if (!usdtAsset) {
      // ملاحظة: نموذج Asset عندك فيه is_deposit_enabled فقط، الباقي سيتجاهله Mongoose إن لم يكن ضمن الـschema
      usdtAsset = new Asset({ symbol: 'USDT', name: 'Tether', is_deposit_enabled: true });
      await usdtAsset.save();
    }
    await FuturesWalletBalance.create({ futures_wallet_id: futuresWallet._id, asset_id: usdtAsset._id, balance: 0 });
    await AIWalletBalance.create({ ai_wallet_id: aiWallet._id, asset_id: usdtAsset._id, balance: 0 });

    // تعيين pool_group دوريًا للمستخدم الجديد
    // استخدم عدد من لديهم pool_group بالفعل لضمان الاستدارة الصحيحة
    const assignedCount = await User.countDocuments({ pool_group: { $ne: null } });
    const pool_group = (assignedCount % totalPools) + 1;

    await User.findByIdAndUpdate(req.user.id, {
      spot_wallet: spotWallet._id,
      futures_wallet: futuresWallet._id,
      ai_wallet: aiWallet._id,
      pool_group
    });

    res.json({ message: 'All wallets initialized successfully.', pool_group });
  } catch (error) {
    console.error('initialize-wallet error:', error);
    res.status(500).json({ error: error.message });
  }
});

// أرصدة Spot
router.get('/spot-balances', authMiddleware, async (req, res) => {
  try {
    const wallet = await SpotWallet.findOne({ user_id: req.user.id });
    if (!wallet) return res.status(404).json({ message: "No Spot Wallet found." });
    const balances = await SpotWalletBalance.find({ spot_wallet_id: wallet._id }).populate('asset_id');
    res.json({ balances });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// أرصدة Futures
router.get('/futures-balances', authMiddleware, async (req, res) => {
  try {
    const wallet = await FuturesWallet.findOne({ user_id: req.user.id });
    if (!wallet) return res.status(404).json({ message: "No Futures Wallet found." });
    const balances = await FuturesWalletBalance.find({ futures_wallet_id: wallet._id }).populate('asset_id');
    res.json({ balances });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// أرصدة AI
router.get('/ai-balances', authMiddleware, async (req, res) => {
  try {
    const wallet = await AIWallet.findOne({ user_id: req.user.id });
    if (!wallet) return res.status(404).json({ message: "No AI Wallet found." });
    const balances = await AIWalletBalance.find({ ai_wallet_id: wallet._id }).populate('asset_id');
    res.json({ balances });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// نظرة إجمالية
router.get('/total-balances', authMiddleware, async (req, res) => {
  try {
    let totalUSDT = 0, todayPNL = 0;
    const spotWallet = await SpotWallet.findOne({ user_id: req.user.id });
    if (spotWallet) {
      const spotBalances = await SpotWalletBalance.find({ spot_wallet_id: spotWallet._id }).populate('asset_id');
      spotBalances.forEach((b) => { if (b.asset_id?.symbol === 'USDT') totalUSDT += b.balance; });
    }
    // يمكنك إكمال حسابات المحافظ الأخرى كما لديك
    todayPNL = 0;
    res.json({ totalUSDT, todayPNL });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// عناويني (من محفظتي المعينة)
router.get('/my-addresses', authMiddleware, async (req, res) => {
  try {
    const me = await User.findById(req.user.id);
    if (!me?.pool_group) return res.json([]);
    const poolIndex = me.pool_group - 1;
    const { wallets } = require('../wallet');
    const pool = wallets[poolIndex];
    if (!pool) return res.json([]);

    const out = [];
    for (const coin of pool.Coins || []) {
      for (const net of coin.networks || []) {
        const addr = net.address || net.addrss;
        if (!addr) continue;
        out.push({ asset_symbol: coin.name, network_name: net.name, address: addr });
      }
    }
    res.json(out);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// إنشاء Intent
router.post('/deposit/intent', authMiddleware, async (req, res) => {
  try {
    const { asset_symbol, network_name, amount } = req.body;
    const me = await User.findById(req.user.id);
    if (!me?.pool_group) return res.status(400).json({ message: 'Initialize wallets first' });

    const spotWallet = await SpotWallet.findOne({ user_id: me._id });
    if (!spotWallet) return res.status(400).json({ message: 'Spot wallet not found' });

    const address = findAddressByPool(me.pool_group - 1, asset_symbol, network_name);
    if (!address) return res.status(400).json({ message: 'No address for your pool/asset/network' });

    const netName = normalizeNetworkName(network_name);
    const isMemoRequired = String(netName).toLowerCase().includes('ripple'); // XRP فقط الآن

    const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
    const expected_amount = isMemoRequired ? String(Number(amount || 0)) : addFingerprint(Number(amount || 0), 6);
    const memo_tag = isMemoRequired ? String(Math.floor(100000 + Math.random() * 900000)) : undefined;

    const intent = await DepositIntent.create({
      user_id: me._id,
      spot_wallet_id: spotWallet._id,
      pool_group: me.pool_group,
      asset_symbol,
      network_name: netName,
      deposit_address: address,
      expected_amount,
      memo_tag,
      expires_at: expiresAt
    });

    res.json({
      intent_id: intent._id,
      address,
      amount_to_send: expected_amount,
      memo_tag,
      expires_at: expiresAt
    });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// سرد Intents
router.get('/deposit/intents', authMiddleware, async (req, res) => {
  try {
    const rows = await DepositIntent.find({ user_id: req.user.id }).sort({ createdAt: -1 }).limit(100);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// IDs للمحافظ
router.get('/wallet-ids/:user_id', getWalletIds);


router.get('/deposits/history', authMiddleware, async (req, res) => {
  try {
    const mySpot = await SpotWallet.findOne({ user_id: req.user.id });
    if (!mySpot) return res.json([]);

    const rows = await Deposit.find({ spot_wallet_id: mySpot._id })
      .sort({ created_at: -1 })
      .limit(100)
      .populate('asset_id'); // لإظهار الرمز بسهولة

    res.json(rows.map(r => ({
      id: r._id,
      asset: r.asset_id?.symbol || '',
      amount: r.amount,
      status: r.status,             // Pending / Completed / Failed
      created_at: r.created_at,
      updated_at: r.updated_at,
      // لو عندك حقول tx_hash/address/network_name ضمن Deposit أرسلها أيضًا:
      // tx_hash: r.tx_hash, address: r.address, network_name: r.network_name
    })));
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});
module.exports = router;
  