// controllers/authController.js
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { User, validateUser } = require('../models/user');
const { Referral, validateReferral } = require('../models/Refferal');

// Try to use central mailer service (services/mailer.js). Fallback to nodemailer if unavailable.
let sendMailWithLogoSafe = null;
try {
  ({ sendMailWithLogoSafe } = require('../services/mailer'));
} catch (e) {
  // optional fallback if services/mailer.js isn't present in runtime
  const nodemailer = require('nodemailer');
  const transporter = nodemailer.createTransport({
    service: process.env.SMTP_SERVICE || 'gmail',
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: Number(process.env.SMTP_PORT || 465),
    secure: true,
    auth: { user: process.env.SMTP_USER || process.env.EMAIL_USER, pass: process.env.SMTP_PASS || process.env.EMAIL_PASS },
    tls: { minVersion: 'TLSv1.2' },
  });
  sendMailWithLogoSafe = async ({ to, subject, html }) => {
    await transporter.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER || process.env.EMAIL_USER, to, subject, html });
    return { ok: true };
  };
}

// ------------------------- Helpers / In-Memory Stores -------------------------
const pendingUsers = new Map(); // key: tempUserId => {username,email,password,referralCode,referredBy,otp,otpExpires}
const pendingPasswordResets = new Map(); // key: tempResetId => { email, userId, otp, otpExpires, attempts, verifiedAt?, resetWindowExpires? }

const REGISTER_OTP_TTL_MS = 10 * 60 * 1000; // 10m
const RESET_OTP_TTL_MS = 10 * 60 * 1000; // 10m
const RESET_OTP_MAX_ATTEMPTS = 5;

function generateSixDigitsOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

async function generateReferralCode() {
  // 8-char uppercase alnum, unique
  let code;
  let isUnique = false;
  do {
    code = Math.random().toString(36).slice(2, 10).toUpperCase();
    const existing = await User.findOne({ referralCode: code });
    isUnique = !existing;
  } while (!isUnique);
  return code;
}

function buildRegisterOtpEmail({ username = 'User', otp }) {
  const brand = '1CryptoX';
  return `
    <div style="font-family:Arial,sans-serif;padding:16px;">
      <h2>${brand} — Verify Your Email</h2>
      <p>Hello ${username},</p>
      <p>Your one-time verification code is:</p>
      <div style="font-size:24px;font-weight:700;letter-spacing:4px;margin:12px 0;">${otp}</div>
      <p>This code expires in <b>10 minutes</b>.</p>
      <hr/><small>© ${new Date().getFullYear()} ${brand}</small>
    </div>
  `;
}

function buildResetEmailHTML({ username = 'User', otp }) {
  const brand = '1CryptoX';
  return `
    <div style="font-family:Arial,sans-serif;padding:16px;">
      <h2>${brand} — Password Reset</h2>
      <p>Hello ${username},</p>
      <p>Use this one-time code to reset your password:</p>
      <div style="font-size:24px;font-weight:700;letter-spacing:4px;margin:12px 0;">${otp}</div>
      <p>The code will expire in <b>10 minutes</b>. If you didn't request this, you can ignore this email.</p>
      <hr/><small>© ${new Date().getFullYear()} ${brand}</small>
    </div>
  `;
}

// ------------------------------ Auth Controllers ------------------------------
/**
 * POST /auth/register
 * body: { username, email, password, referralCode? }
 * Flow: send OTP to email, keep data pending until verifyOtp
 */
const register = async (req, res) => {
  try {
    const { error } = validateUser(req.body);
    if (error) return res.status(400).json({ message: error.details[0].message });

    const { username, email, password, referralCode } = req.body;

    const existingByEmail = await User.findOne({ email });
    if (existingByEmail) return res.status(400).json({ message: 'Email already in use' });

    // Hash password early
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    // Prepare OTP
    const otp = generateSixDigitsOTP();
    const otpExpires = Date.now() + REGISTER_OTP_TTL_MS;

    // Generate new user's own referral code
    const newUserReferralCode = await generateReferralCode();

    // Optional referrer
    let referredBy = null;
    if (referralCode) {
      const referrer = await User.findOne({ referralCode });
      if (!referrer) return res.status(400).json({ message: 'Invalid referral code' });
      referredBy = referrer._id;
    }

    // Stash pending
    const tempUserId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    pendingUsers.set(tempUserId, {
      username,
      email,
      password: hashedPassword,
      referralCode: newUserReferralCode,
      referredBy,
      otp,
      otpExpires,
    });

    const html = buildRegisterOtpEmail({ username, otp });
    const sent = await sendMailWithLogoSafe({
      to: email,
      subject: 'Your 1CryptoX Verification Code',
      html,
      category: 'register-otp',
    });
    if (!sent || !sent.ok) {
      pendingUsers.delete(tempUserId);
      return res.status(500).json({ message: 'Failed to send verification email. Try again later.' });
    }

    return res.status(200).json({
      message: 'OTP sent to your email',
      tempUserId,
      expiresInMs: REGISTER_OTP_TTL_MS,
    });
  } catch (err) {
    console.error('register error:', err);
    return res.status(500).json({ message: 'Server error' });
  }
};

/**
 * POST /auth/verify-otp
 * body: { tempUserId, otp }
 * Creates user, issues JWT, records referral if provided earlier
 */
const verifyOtp = async (req, res) => {
  try {
    const { tempUserId, otp } = req.body || {};
    if (!tempUserId || !otp) return res.status(400).json({ message: 'tempUserId and otp are required' });

    const pendingUser = pendingUsers.get(tempUserId);
    if (!pendingUser) return res.status(400).json({ message: 'Session expired or invalid' });

    if (Date.now() > pendingUser.otpExpires) {
      pendingUsers.delete(tempUserId);
      return res.status(400).json({ message: 'OTP has expired. Please register again.' });
    }

    if (pendingUser.otp !== otp) {
      return res.status(400).json({ message: 'Invalid OTP' });
    }

    // Create user
    const user = new User({
      username: pendingUser.username,
      email: pendingUser.email,
      password: pendingUser.password,
      referralCode: pendingUser.referralCode,
      role: 'user',
    });
    await user.save();

    // Handle referral record if any
    if (pendingUser.referredBy) {
      const referralData = {
        referrer_id: pendingUser.referredBy,
        referred_user_id: user._id,
        status: 'Pending',
        trade_met: false,
        trade_amount: 0,
        min_trade_amount: 50,
      };
      const { error } = validateReferral(referralData);
      if (error) {
        console.warn('Referral validation warning:', error.details[0].message);
      } else {
        const referral = new Referral(referralData);
        await referral.save();
      }
    }

    pendingUsers.delete(tempUserId);

    const token = jwt.sign(
      { id: user._id, role: user.role },
      process.env.JWT_SECRET || 'your-secret-key',
      { expiresIn: '15d' }
    );

    return res.status(200).json({
      message: 'User registered successfully',
      token,
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        role: user.role,
        referralCode: user.referralCode,
      },
    });
  } catch (err) {
    console.error('verifyOtp error:', err);
    return res.status(500).json({ message: 'Server error' });
  }
};

/**
 * POST /auth/login
 * body: { email, password }
 * Regular email/password login
 */
const login = async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ message: 'Email and password are required' });

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

    return res.status(200).json({
      message: 'Login successful',
      token,
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        role: user.role,
        profile_image: user.profile_image,
        referralCode: user.referralCode,
      },
    });
  } catch (err) {
    console.error('login error:', err);
    return res.status(500).json({ message: 'Server error' });
  }
};

/**
 * POST /auth/forgot-password
 * body: { email }
 * Sends OTP to email if the account exists (doesn’t reveal existence)
 */
const requestPasswordReset = async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ message: 'Email is required' });

    const user = await User.findOne({ email });
    if (!user) {
      // Do not reveal existence
      return res.status(200).json({ message: 'If this email exists, an OTP has been sent' });
    }

    const otp = generateSixDigitsOTP();
    const tempResetId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

    pendingPasswordResets.set(tempResetId, {
      email,
      userId: String(user._id),
      otp,
      otpExpires: Date.now() + RESET_OTP_TTL_MS,
      attempts: 0,
    });

    const html = buildResetEmailHTML({ username: user.username || 'User', otp });
    const sent = await sendMailWithLogoSafe({
      to: email,
      subject: 'Your 1CryptoX Password Reset Code',
      html,
      category: 'password-reset',
    });
    if (!sent || !sent.ok) {
      pendingPasswordResets.delete(tempResetId);
      return res.status(500).json({ message: 'Failed to send email. Try again later.' });
    }

    return res.status(200).json({
      message: 'OTP sent to your email (if the address exists).',
      tempResetId,
      expiresInMs: RESET_OTP_TTL_MS,
    });
  } catch (err) {
    console.error('requestPasswordReset error:', err);
    return res.status(500).json({ message: 'Server error' });
  }
};

/**
 * POST /auth/verify-reset-otp
 * body: { tempResetId, otp }
 * Verifies OTP and opens a short reset window
 */
const verifyResetOtp = async (req, res) => {
  try {
    const { tempResetId, otp } = req.body || {};
    if (!tempResetId || !otp) return res.status(400).json({ message: 'tempResetId and otp are required' });

    const entry = pendingPasswordResets.get(tempResetId);
    if (!entry) return res.status(400).json({ message: 'Session expired or invalid' });

    if (Date.now() > entry.otpExpires) {
      pendingPasswordResets.delete(tempResetId);
      return res.status(400).json({ message: 'OTP has expired. Please request a new one.' });
    }

    if (entry.attempts >= RESET_OTP_MAX_ATTEMPTS) {
      pendingPasswordResets.delete(tempResetId);
      return res.status(429).json({ message: 'Too many attempts. Please request a new OTP.' });
    }

    entry.attempts += 1;

    if (entry.otp !== otp) {
      return res.status(400).json({ message: 'Invalid OTP' });
    }

    entry.verifiedAt = Date.now();
    entry.resetWindowExpires = Date.now() + RESET_OTP_TTL_MS;

    return res.status(200).json({ message: 'OTP verified. You can reset password now.' });
  } catch (err) {
    console.error('verifyResetOtp error:', err);
    return res.status(500).json({ message: 'Server error' });
  }
};

/**
 * POST /auth/reset-password
 * body: { tempResetId, newPassword }
 * Resets password if OTP verified and window active
 */
const resetPassword = async (req, res) => {
  try {
    const { tempResetId, newPassword } = req.body || {};
    if (!tempResetId || !newPassword) return res.status(400).json({ message: 'tempResetId and newPassword are required' });
    if (typeof newPassword !== 'string' || newPassword.length < 8) {
      return res.status(400).json({ message: 'Password must be at least 8 characters' });
    }

    const entry = pendingPasswordResets.get(tempResetId);
    if (!entry) return res.status(400).json({ message: 'Session expired or invalid' });

    if (!entry.verifiedAt || Date.now() > (entry.resetWindowExpires || 0)) {
      pendingPasswordResets.delete(tempResetId);
      return res.status(400).json({ message: 'Reset window expired. Please verify OTP again.' });
    }

    const user = await User.findById(entry.userId);
    if (!user) {
      pendingPasswordResets.delete(tempResetId);
      return res.status(400).json({ message: 'User no longer exists' });
    }

    const salt = await bcrypt.genSalt(10);
    user.password = await bcrypt.hash(newPassword, salt);
    await user.save();

    pendingPasswordResets.delete(tempResetId);

    return res.status(200).json({ message: 'Password has been reset successfully' });
  } catch (err) {
    console.error('resetPassword error:', err);
    return res.status(500).json({ message: 'Server error' });
  }
};

const logout = (req, res) => {
  return res.status(200).json({ message: 'Logged out successfully' });
};

module.exports = {
  register,
  verifyOtp,
  login,
  logout,
  requestPasswordReset,
  verifyResetOtp,
  resetPassword,
};
