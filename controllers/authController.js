// routes/auth.js
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const { User, validateUser } = require('../models/user');
const { Referral, validateReferral } = require('../models/Refferal');

const pendingUsers = new Map();

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// Function to generate a unique referral code
const generateReferralCode = async () => {
  const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code;
  let isUnique = false;
  do {
    code = '';
    for (let i = 0; i < 6; i++) {
      code += characters.charAt(Math.floor(Math.random() * characters.length));
    }
    const existingUser = await User.findOne({ referralCode: code });
    isUnique = !existingUser;
  } while (!isUnique);
  return code;
};

const register = async (req, res) => {
  try {
    const { error } = validateUser(req.body);
    if (error) return res.status(400).json({ message: error.details[0].message });

    const { username, email, password, referralCode } = req.body;

    const existingUser = await User.findOne({ $or: [{ email }, { username }] });
    if (existingUser) return res.status(400).json({ message: 'The user already exists' });

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const otpExpires = Date.now() + 10 * 60 * 1000;

    // Generate a unique referral code for the new user
    const newUserReferralCode = await generateReferralCode();

    // Verify the provided referral code (if any)
    let referredBy = null;
    if (referralCode) {
      const referrer = await User.findOne({ referralCode });
      if (!referrer) return res.status(400).json({ message: 'Invalid referral code' });
      referredBy = referrer._id;
    }

    const tempUserId = `${Date.now()}-${Math.random().toString(36).substring(2)}`;
    pendingUsers.set(tempUserId, {
      username,
      email,
      password: hashedPassword,
      referralCode: newUserReferralCode,
      referredBy,
      otp,
      otpExpires,
    });

    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: email,
      subject: 'Your TradeVerse OTP Code',
      text: `Your OTP code is ${otp}. It expires in 10 minutes.`,
    });

    res.status(201).json({
      message: 'OTP sent to your email. Please verify to complete registration.',
      tempUserId,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

const verifyOtp = async (req, res) => {
  try {
    const { tempUserId, otp } = req.body;

    const pendingUser = pendingUsers.get(tempUserId);
    if (!pendingUser) return res.status(400).json({ message: 'User not found or expired' });

    if (Date.now() > pendingUser.otpExpires) {
      pendingUsers.delete(tempUserId);
      return res.status(400).json({ message: 'OTP has expired. Please register again.' });
    }

    if (pendingUser.otp !== otp) {
      return res.status(400).json({ message: 'Invalid OTP. Please try again.' });
    }

    const user = new User({
      username: pendingUser.username,
      email: pendingUser.email,
      password: pendingUser.password,
      role: 'User',
      referralCode: pendingUser.referralCode,
      referredBy: pendingUser.referredBy,
    });

    await user.save();

    // If there’s a referral, create a referral record
    if (pendingUser.referredBy) {
      const referralData = {
        referrer_id: pendingUser.referredBy,
        referred_user_id: user._id,
        status: 'Pending',
        trade_met: false,
        trade_amount: 0,
        min_trade_amount: 50
      };
      const { error } = validateReferral(referralData);
      if (error) throw new Error(error.details[0].message);
      const referral = new Referral(referralData);
      await referral.save();
    }

    const token = jwt.sign(
      { id: user._id, role: user.role },
      process.env.JWT_SECRET || 'your-secret-key',
      { expiresIn: '15d' }
    );

    pendingUsers.delete(tempUserId);

    res.status(200).json({
      message: 'User registered successfully',
      token,
      user: { id: user._id, username: user.username, email: user.email, role: user.role, referralCode: user.referralCode }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

const login = async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ message: 'Invalid email or password' });

    if (user.googleId || user.xId) {
      return res.status(400).json({ message: 'Please use Google or X to login' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ message: 'Invalid email or password' });

    const token = jwt.sign(
      { id: user._id, role: user.role },
      process.env.JWT_SECRET || 'your-secret-key',
      { expiresIn: '15d' }
    );

    res.status(200).json({
      message: 'Login successful',
      token,
      user: {
        id: user._id,
        username: user.username,
        email,
        role: user.role,
        profile_image: user.profile_image,
        referralCode: user.referralCode
      },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

const logout = (req, res) => {
  res.status(200).json({ message: 'Logged out successfully' });
};

module.exports = { register, login, verifyOtp, logout };