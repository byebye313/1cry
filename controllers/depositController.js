const { Asset } = require('../models/Asset');
const { Deposit, validateDeposit } = require('../models/Deposit');
const { User } = require('../models/User');
const { SpotWalletBalance } = require('../models/SpotWalletBalance');
const { verifyTransaction } = require('../utils/blockchainVerifier');

const getAvailableDeposits = async (req, res) => {
  try {
    const assets = await Asset.find({ is_deposit_enabled: true }).select('symbol name networks');
    res.status(200).json(assets);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

const createDeposit = async (req, res) => {
  try {
    const { error } = validateDeposit(req.body);
    if (error) return res.status(400).json({ message: error.details[0].message });

    const { asset_id, network_name, amount } = req.body;

    const asset = await Asset.findById(asset_id);
    if (!asset || !asset.is_deposit_enabled) {
      return res.status(400).json({ message: 'Invalid or disabled asset' });
    }

    const network = asset.networks.find((n) => n.name === network_name);
    if (!network) return res.status(400).json({ message: 'Invalid network' });

    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: 'User not found' });

    const deposit = new Deposit({
      user_id: user._id,
      spot_wallet_id: user.spot_wallet,
      asset_id,
      amount,
      status: 'Pending',
      network_name,
      deposit_address: network.address,
    });

    await deposit.save();

    res.status(201).json({
      message: 'Deposit request created successfully',
      deposit: {
        id: deposit._id,
        asset_symbol: asset.symbol,
        amount,
        network_name,
        deposit_address: network.address,
        status: deposit.status,
      },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

const verifyDeposit = async (req, res) => {
  try {
    const { deposit_id, transaction_hash } = req.body;

    const deposit = await Deposit.findById(deposit_id).populate('asset_id');
    if (!deposit || deposit.user_id.toString() !== req.user.id) {
      return res.status(404).json({ message: 'Deposit not found or unauthorized' });
    }
    if (deposit.status !== 'Pending') {
      return res.status(400).json({ message: 'Deposit already processed' });
    }

    // التحقق من المعاملة
    const { verified, reason } = await verifyTransaction(
      deposit.network_name,
      transaction_hash,
      deposit.deposit_address,
      deposit.amount,
      deposit.asset_id.symbol
    );

    if (!verified) {
      deposit.status = 'Failed';
      await deposit.save();
      return res.status(400).json({ message: `Deposit verification failed: ${reason}` });
    }

    // تحديث حالة الإيداع وإضافة الرصيد
    deposit.status = 'Completed';
    deposit.transaction_hash = transaction_hash;
    await deposit.save();

    // تحديث رصيد المحفظة
    let balance = await SpotWalletBalance.findOne({
      spot_wallet_id: deposit.spot_wallet_id,
      asset_id: deposit.asset_id,
    });
    if (!balance) {
      balance = new SpotWalletBalance({
        spot_wallet_id: deposit.spot_wallet_id,
        asset_id: deposit.asset_id,
        balance: deposit.amount,
      });
    } else {
      balance.balance += deposit.amount;
    }
    await balance.save();

    res.status(200).json({
      message: 'Deposit verified and completed successfully',
      deposit: {
        id: deposit._id,
        asset_symbol: deposit.asset_id.symbol,
        amount: deposit.amount,
        network_name: deposit.network_name,
        status: deposit.status,
      },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

module.exports = { getAvailableDeposits, createDeposit, verifyDeposit };