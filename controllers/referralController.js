const mongoose = require('mongoose');
const { Referral } = require('../models/Refferal');
const { SpotWallet } = require('../models/SpotWallet');
const { SpotWalletBalance } = require('../models/SpotWalletBalance');
const { Asset } = require('../models/Asset');
const { Notification } = require('../models/Notification');
const { User } = require('../models/user');

const referralController = {
  // Create a new referral
  createReferral: async (req, res) => {
    const { user_id, referral_code } = req.body;
    try {
      if (!mongoose.Types.ObjectId.isValid(user_id)) {
        return res.status(400).json({ error: 'Invalid user_id' });
      }

      // Find the referrer using the referral code
      const referrerUser = await User.findOne({ referralCode: referral_code });
      if (!referrerUser) {
        return res.status(400).json({ error: 'Invalid referral code' });
      }
      const referrer_id = referrerUser._id;

      // Find the referred user (current user)
      const referredUser = await User.findById(user_id);
      if (!referredUser) {
        return res.status(404).json({ error: 'User not found' });
      }
      const referred_user_id = referredUser._id;

      // Prevent self-referral
      if (referrer_id.toString() === referred_user_id.toString()) {
        return res.status(400).json({ error: 'Cannot refer yourself' });
      }

      // Check for existing referral
      const existingReferral = await Referral.findOne({ referrer_id, referred_user_id });
      if (existingReferral) {
        return res.status(400).json({ error: 'Referral already exists' });
      }

      // Check if user already has a referrer
      if (referredUser.referredBy) {
        return res.status(400).json({ error: 'You already have a referrer' });
      }

      // Create referral record
      const referral = new Referral({
        referrer_id,
        referred_user_id,
        status: 'Pending',
        created_at: new Date(),
      });
      await referral.save();

      // Update referredBy field for the referred user
      referredUser.referredBy = referrer_id;
      await referredUser.save();

      // Create notification for referred user
      const notificationForReferred = new Notification({
        user_id: referred_user_id,
        type: 'Referral',
        title: 'Referral Added',
        message: `You have been referred by ${referrerUser.username}! Complete a trade of at least 50 USDT to make it eligible.`,
        is_read: false,
        created_at: new Date(),
      });
      await notificationForReferred.save();

      // Create notification for referrer
      const notificationForReferrer = new Notification({
        user_id: referrer_id,
        type: 'Referral',
        title: 'New Referred User',
        message: `A new user has used your referral code! The referral is pending until they trade at least 50 USDT.`,
        is_read: false,
        created_at: new Date(),
      });
      await notificationForReferrer.save();

      // Return updated user data
      const updatedUser = await User.findById(referred_user_id)
        .select('-password')
        .populate('referredBy', 'username referralCode');

      res.status(201).json({
        referral: referral.toObject(),
        user: updatedUser,
        message: 'Referral created successfully',
      });
    } catch (error) {
      console.error('Error creating referral:', error.message, error.stack);
      res.status(500).json({ error: 'Internal server error' });
    }
  },

  // Get referral status and count for a user (referrer)
  getReferralStatus: async (req, res) => {
    const { referrer_id } = req.params;
    try {
      if (!mongoose.Types.ObjectId.isValid(referrer_id)) {
        return res.status(400).json({ error: 'Invalid referrer_id' });
      }

      const referrals = await Referral.find({ referrer_id });
      const pendingCount = referrals.filter((r) => r.status === 'Pending').length;
      const eligibleCount = referrals.filter((r) => r.status === 'Eligible').length;
      const completedCount = referrals.filter((r) => r.status === 'Completed').length;

      res.status(200).json({
        referrals,
        counts: {
          pending: pendingCount,
          eligible: eligibleCount,
          completed: completedCount,
        },
      });
    } catch (error) {
      console.error('Error fetching referral status:', error.message, error.stack);
      res.status(500).json({ error: 'Internal server error' });
    }
  },

  // Collect referral prize based on eligible referral count
  collectReferralPrize: async (req, res) => {
    const { referrer_id } = req.body;
    try {
      if (!mongoose.Types.ObjectId.isValid(referrer_id)) {
        return res.status(400).json({ error: 'Invalid referrer_id' });
      }

      const eligibleReferrals = await Referral.find({ referrer_id, status: 'Eligible' });
      const eligibleCount = eligibleReferrals.length;

      let reward_amount = 0;
      if (eligibleCount >= 100) {
        reward_amount = 10000;
      } else if (eligibleCount >= 50) {
        reward_amount = 5000;
      } else if (eligibleCount >= 20) {
        reward_amount = 1000;
      } else {
        return res.status(400).json({ error: 'Not enough eligible referrals to claim a prize' });
      }

      const spotWallet = await SpotWallet.findOne({ user_id: referrer_id });
      if (!spotWallet) {
        return res.status(404).json({ error: 'Spot wallet not found' });
      }

      const usdtAsset = await Asset.findOne({ symbol: 'USDT' });
      if (!usdtAsset) {
        return res.status(404).json({ error: 'USDT asset not found' });
      }

      const spotWalletBalance = await SpotWalletBalance.findOne({
        spot_wallet_id: spotWallet._id,
        asset_id: usdtAsset._id,
      });
      if (!spotWalletBalance) {
        return res.status(404).json({ error: 'Spot wallet balance not found' });
      }

      // Update referral statuses to Completed and record reward
      await Referral.updateMany(
        { referrer_id, status: 'Eligible' },
        {
          $set: {
            status: 'Completed',
            reward_amount,
            completed_at: new Date(),
          },
        }
      );

      // Add reward to spot wallet balance
      spotWalletBalance.balance += reward_amount;
      await spotWalletBalance.save();

      // Notify user of reward collection
      const notification = new Notification({
        user_id: referrer_id,
        type: 'Referral',
        title: 'Reward Collected',
        message: `Congratulations! You collected a ${reward_amount} USDT reward for referring ${eligibleCount} users!`,
        is_read: false,
        created_at: new Date(),
      });
      await notification.save();

      res.status(200).json({
        message: `Reward of ${reward_amount} USDT added to your spot wallet`,
        newBalance: spotWalletBalance.balance,
        eligible_count: eligibleCount,
      });
    } catch (error) {
      console.error('Error collecting referral prize:', error.message, error.stack);
      res.status(500).json({ error: 'Internal server error' });
    }
  },

  // Get referral statistics for a referrer
  getReferralStats: async (req, res) => {
    const { referrer_id } = req.params;
    try {
      if (!mongoose.Types.ObjectId.isValid(referrer_id)) {
        return res.status(400).json({ error: 'Invalid referrer_id' });
      }

      const referrals = await Referral.find({ referrer_id });
      const totalReferrals = referrals.length;
      const totalTradeAmount = referrals.reduce((sum, r) => sum + (r.trade_amount || 0), 0);
      const totalRewardsEarned = referrals.reduce((sum, r) => sum + (r.reward_amount || 0), 0);

      res.status(200).json({
        totalReferrals,
        totalTradeAmount,
        totalRewardsEarned,
      });
    } catch (error) {
      console.error('Error fetching referral stats:', error.message, error.stack);
      res.status(500).json({ error: 'Internal server error' });
    }
  },

  // Get referral reward history for a referrer
  getRewardHistory: async (req, res) => {
    const { referrer_id } = req.params;
    try {
      if (!mongoose.Types.ObjectId.isValid(referrer_id)) {
        return res.status(400).json({ error: 'Invalid referrer_id' });
      }

      const completedReferrals = await Referral.find({
        referrer_id,
        status: 'Completed',
        reward_amount: { $gt: 0 },
      }).select('reward_amount completed_at');

      const rewardHistory = completedReferrals.map((r) => ({
        reward_amount: r.reward_amount,
        eligible_count: r.reward_amount === 10000 ? 100 : r.reward_amount === 5000 ? 50 : 20,
        collected_at: r.completed_at,
      }));

      res.status(200).json(rewardHistory);
    } catch (error) {
      console.error('Error fetching reward history:', error.message, error.stack);
      res.status(500).json({ error: 'Internal server error' });
    }
  },
};

module.exports = { referralController };