const { LuckWheelSpin, validateLuckWheelSpin } = require('../models/LuckWheelSpin');
const { User } = require('../models/user');
const { SpotWallet } = require('../models/SpotWallet');
const { SpotWalletBalance } = require('../models/SpotWalletBalance');

// Weighted probabilities for reward percentages
const getRewardPercentage = (isSupport) => {
    const weights = [
        { value: 1, weight: 80 },   // 40% chance
        { value: 3, weight: 10 },   // 30% chance
        { value: 5, weight: 5 },   // 15% chance
        { value: 7, weight: 1 }    // 10% chance
    ];
    
    if (isSupport) {
        weights.push({ value: 10, weight: 4 });  // 4% chance for Support
        weights.push({ value: 100, weight: 1 }); // 1% chance for Support
    }

    const totalWeight = weights.reduce((sum, option) => sum + option.weight, 0);
    const random = Math.random() * totalWeight;
    let cumulativeWeight = 0;

    for (const option of weights) {
        cumulativeWeight += option.weight;
        if (random <= cumulativeWeight) {
            return option.value;
        }
    }
    return 1; // Fallback to 1%
};

const spinWheel = async (req, res) => {
    try {
        const { user_id, spot_wallet_id } = req.body;

        // Validate input
        const { error } = validateLuckWheelSpin(req.body);
        if (error) return res.status(400).json({ message: error.details[0].message });

        // Check user and wallet existence
        const user = await User.findById(user_id);
        if (!user) return res.status(404).json({ message: 'User not found' });

        const spotWallet = await SpotWallet.findOne({ _id: spot_wallet_id, user_id });
        if (!spotWallet) return res.status(404).json({ message: 'Spot wallet not found' });
        if (user.spot_wallet.toString() !== spot_wallet_id) {
            return res.status(403).json({ message: 'Spot wallet does not belong to this user' });
        }

        // Check if user already spun today
        const today = new Date().setHours(0, 0, 0, 0);
        const existingSpin = await LuckWheelSpin.findOne({
            user_id,
            spin_date: { $gte: today, $lt: new Date(today + 24 * 60 * 60 * 1000) }
        });
        if (existingSpin) return res.status(403).json({ message: 'You can only spin once per day' });

        // Determine reward percentage based on role
        const isSupport = user.role === 'Support';
        const rewardPercentage = getRewardPercentage(isSupport);

        // Calculate reward amount based on current spot wallet balance
        const spotBalance = await SpotWalletBalance.findOne({ spot_wallet_id });
        if (!spotBalance) return res.status(404).json({ message: 'Spot wallet balance not found' });
        
        const rewardAmount = spotBalance.balance * (rewardPercentage / 100);

        // Create spin record
        const spin = new LuckWheelSpin({
            user_id,
            spot_wallet_id,
            reward_percentage: rewardPercentage,
            reward_amount: rewardAmount,
            spin_date: today
        });
        await spin.save();

        // Update spot wallet balance
        spotBalance.balance += rewardAmount;
        await spotBalance.save();

        res.status(200).json({
            message: 'Wheel spun successfully',
            reward_percentage: rewardPercentage,
            reward_amount: rewardAmount
        });
    } catch (error) {
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

const getSpinHistory = async (req, res) => {
    try {
        const { userId } = req.params;
        const spins = await LuckWheelSpin.find({ user_id: userId })
            .populate('user_id', 'username email')
            .populate('spot_wallet_id')
            .sort({ created_at: -1 });
        
        res.status(200).json(spins);
    } catch (error) {
        res.status(500).json({ message: 'Server error', error: error.message });
    }
};

module.exports = { spinWheel, getSpinHistory };