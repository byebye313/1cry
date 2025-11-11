const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const { ValidateRegisterUser, User } = require('./../models/user');
const Wallet = require('./../models/wallets'); // Import the Wallet model
const Notification = require('../models/Notification');

const router = express.Router();

const generateOtp = () => Math.floor(100000 + Math.random() * 900000).toString();

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: "cryptox.ex@gmail.com",
    pass: "gxbc slow yjnl yvvp"
  }
});

const sendOtpEmail = async (email, otp) => {
  const mailOptions = {
    from: "cryptox.ex@gmail.com",
    to: email,
    subject: 'Your Verification Code',
    html: `
      <html>
        <head>
          <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;600&display=swap">
          <style>
            body {
              font-family: 'Poppins', sans-serif;
              background-color: #f4f4f4;
              margin: 0;
              padding: 0;
            }
            .container {
              max-width: 600px;
              margin: auto;
              background-color: #ffffff;
              padding: 20px;
              border-radius: 8px;
              box-shadow: 0 0 10px rgba(0,0,0,0.1);
            }
            .header {
              text-align: center;
              padding-bottom: 20px;
            }
            .header h1 {
              margin: 0;
              font-size: 36px;
              color: #333333;
            }
            .header h1 i {
              color: #9406F2;
            }
            .content {
              text-align: center;
              padding: 20px;
            }
            .content p {
              font-size: 16px;
              color: #777777;
              margin: 0 0 10px 0;
            }
            .content h3 {
              font-size: 24px;
              color: #456fdf;
              margin: 20px 0;
            }
            .footer {
              text-align: center;
              font-size: 12px;
              color: #777777;
              padding-top: 20px;
              border-top: 1px solid #e0e0e0;
              margin-top: 20px;
              line-height: 1.6;
            }
            .footer p {
              margin: 10px 0;
            }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>Crypto<i>X</i></h1>
            </div>
            <div class="content">
              <p>Thank you for registering with CryptoX! To complete your registration, please use the verification code below:</p>
              <h3>${otp}</h3>
              <p>This code is valid for 10 minutes.</p>
              <p>If you didn't request this code, please ignore this email.</p>
            </div>
            <div class="footer">
              <p>CryptoX trademark is owned by CryptoX Ltd.</p>
              <p>Company regulated by the relevant financial authorities.</p>
              <p>Registration number: 80132848-2.</p>
              <p>© 2022 - 2024 CryptoX</p>
            </div>
          </div>
        </body>
      </html>
    `
  };
  await transporter.sendMail(mailOptions);
};

router.post('/register', async (req, res) => {
  const { error } = ValidateRegisterUser(req.body);
  if (error) return res.status(400).json({ message: error.details[0].message });

  let user = await User.findOne({ email: req.body.email });
  if (user) return res.status(400).json({ message: 'This User Is Already Registered' });

  const otp = generateOtp();
  await sendOtpEmail(req.body.email, otp);

  const otpToken = jwt.sign({ otp, userDetails: req.body }, process.env.JWT_SECRET_KEY, { expiresIn: '10m' });

  // Fetch all wallets and sort them
  const wallets = await Wallet.find().sort({ _id: 1 });
  if (!wallets || wallets.length === 0) {
    return res.status(500).json({ message: 'No wallets found.' });
  }

  // Count the number of existing users
  const userCount = await User.countDocuments();

  // Determine mainWallet and externalWallet
  let mainWallet;
  let externalWallet;

  if (userCount < 4) {
    mainWallet = wallets.find(wallet => wallet.name === 'boyka');
  } else {
    const indexOffset = userCount - 4; // Adjust index to start after 'boyka'
    const startIndex = wallets.findIndex(wallet => wallet.name === 'boyka') + 1;
    const walletIndex = (indexOffset % (wallets.length - 1)) + startIndex;
    mainWallet = wallets[walletIndex];
  }

  if (!mainWallet) {
    return res.status(500).json({ message: 'Main wallet not found.' });
  }

  // The externalWallet can be the same as the mainWallet or another wallet of your choice
  externalWallet = wallets.find(wallet => wallet._id.toString() !== mainWallet._id.toString()) || mainWallet;

  // Create the new user with assigned wallets and temporary password
  user = new User({
    email: req.body.email,
    username: req.body.username,
    password: req.body.password, // Temporary password, will be hashed after OTP verification
    futureAccount: 0,
    spotBalance: 0,
    ActiveAccount: false,
    mainWallet: mainWallet._id,
    ExWallet: externalWallet._id
  });

  await user.save();

  res.status(200).json({ message: 'OTP sent to your email. Please verify.', otpToken });
});

router.post('/verify-otp', async (req, res) => {
  const { otp, otpToken } = req.body;

  try {
    const decoded = jwt.verify(otpToken, process.env.JWT_SECRET_KEY);
    if (otp !== decoded.otp) return res.status(400).json({ message: 'Invalid OTP' });

    const userDetails = decoded.userDetails;
    const salt = await bcrypt.genSalt(10);
    userDetails.password = await bcrypt.hash(userDetails.password, salt);

    // Find the user based on email and update their password
    let user = await User.findOneAndUpdate(
      { email: userDetails.email },
      { password: userDetails.password },
      { new: true }
    );

    const token = jwt.sign({ id: user._id, isAdmin: user.isAdmin }, process.env.JWT_SECRET_KEY);
    const { password, ...other } = user._doc;

    res.status(201).json({ message: 'Registered Successfully', ...other, token });

  } catch (err) {
    res.status(400).json({ message: 'Invalid or expired OTP token' });
  }
});


router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  // Validate the request body
  if (!email || !password) {
      return res.status(400).json({ message: 'Email and password are required' });
  }

  try {
      // Find the user by email and populate notifications
      const user = await User.findOne({ email }).populate('notifications');
      if (!user) {
          return res.status(400).json({ message: 'Invalid email or password' });
      }

      // Check if the password is correct
      const isMatch = await bcrypt.compare(password, user.password);
      if (!isMatch) {
          return res.status(400).json({ message: 'Invalid email or password' });
      }

      // Check if this is the user's first login by seeing if they have any notifications
      if (user.notifications.length === 0) {
          // Create the "Account Activation Process" notification
          const activationNotification = new Notification({
              title: "Account Activation Process",
              content: `To Activate your account, we kindly ask you to complete a deposit. Following this, we will verify the source of the funds to ensure that it is not associated with any illicit activities, such as hacking, dark web transactions, or money laundering.

This verification process is essential for us to maintain the integrity and safety of our platform. Your cooperation is greatly appreciated as we strive to create a secure environment for all our users.

Thank you for your understanding`,
              user: user._id
          });

          // Save the notification
          await activationNotification.save();

          // Add the notification to the user's notifications array
          user.notifications.push(activationNotification._id);
          await user.save();
      }

      // Generate JWT token
      const token = jwt.sign(
          { id: user._id, isAdmin: user.isAdmin },
          process.env.JWT_SECRET_KEY,
          { expiresIn: '1h' }
      );

      // Send response with notifications
      res.status(200).json({
          message: 'Login successful',
          token,
          user: {
              id: user._id,
              email: user.email,
              username: user.username,
              futureAccount: user.futureAccount,
              spotBalance: user.spotBalance,
              ActiveAccount: user.ActiveAccount,
              notifications: user.notifications,
              mainWallet: user.mainWallet,
              ExWallet: user.ExWallet
          }
      });
  } catch (error) {
      res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
