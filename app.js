// app.js (CORS from .env only)
const express = require('express');
const mongoose = require('mongoose');
const { notFound, errorHandler } = require('./middlewares/errorHandler');
const { logger } = require('./middlewares/logger');
const authMiddleware = require('./middlewares/authMiddleware');
const cors = require('cors');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
require('dotenv').config();

// ===== CORS (from .env via separate helper) =====
const { originFn } = require('./cors-origins');

// Routes
const coinRoutes = require('./coins/routes');
const spotTradeRoutes = require('./routes/spotTradeRoutes');
const futuresTradeRoutes = require('./routes/futuresTradeRoutes');
const transferRoutes = require('./routes/transferRoutes');
const supportRoutes = require('./routes/supportRoutes');
const authRoutes = require('./routes/Auth');
const userRouter = require('./routes/User');
const LuckWheelRouter = require('./routes/LuckWheelRoutes');
const withdrawalRouter = require('./routes/withdrawalRoutes');
const profileImagesRouter = require('./routes/profileImages');
const assetRoutes = require('./routes/assetRoutes');
const walletRoutes = require('./routes/walletRoutes');
const aiTradeRoutes = require('./routes/aiTradeRoutes');
const notification = require('./routes/NotificationRoutes');
const refferal = require('./routes/referralRoutes');
const kycRoutes = require('./routes/kycRoutes'); // KYC
const { startAllWatchers } = require('./workers/poller');
const supportPredictionRoutes  = require('./routes/supportPredictionRoutes');
// Other services
const { initializeSupportWebSocket } = require('./services/supportService');
const { initializePriceWebSocket, schedulePredictionFetch } = require('./services/aiTradeService');
const { User } = require('./models/user');

const promotionRoutes = require('./routes/promotionRoutes');
const promotionLeaderboardRoutes = require('./routes/promotionLeaderboardRoutes'); // اختياري

// Futures services
const { initFuturesEngine } = require('./services/futuresEngine');
const { initFuturesPriceFeed } = require('./services/futuresPriceFeed');

const app = express();
const server = http.createServer(app);

// لو كنت خلف Proxy (Cloudflare/NGINX) وتتعامل مع Cookies跨-دومين:
app.set('trust proxy', 1);

// ===== Socket.IO (CORS uses originFn from .env) =====
const io = new Server(server, {
  cors: {
    origin: originFn,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    credentials: true,
    // allowedHeaders ليست مطلوبة عادة، لكن يمكن إضافتها لو احتجت
    // allowedHeaders: ['Content-Type', 'Authorization'],
  },
});
app.set('io', io); // مهم: ليقرأه withdrawalRoutes عبر req.app.get('io')

mongoose.set('strictQuery', false);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(logger);

// ===== Global CORS (Express) — من .env فقط =====
const corsConfig = {
  origin: originFn,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
  optionsSuccessStatus: 204,
};
app.use(cors(corsConfig));
// تأكيد الـ preflight لأي مسار
app.options('*', cors(corsConfig));

// *** أزلنا الميدلوير اليدوي الذي كان يضيف رؤوس CORS لتفادي الازدواجية ***

// ===== Static (public + user uploads) =====
app.use(express.static(path.join(__dirname, 'public')));
app.use('/ProfileImages', express.static(path.join(__dirname, 'ProfileImages')));
app.use('/uploadedProfile', express.static(path.join(__dirname, 'uploadedProfile')));

// NEW: Serve KYC / general uploads (ضع مجلد uploads في الجذر)
app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')));

// Healthcheck
app.get('/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime(), pid: process.pid, time: new Date().toISOString() });
});

// ===== Routes (NOTE: withdrawals uses PATCH on approve/reject/complete) =====
app.use('/api/user', authMiddleware, userRouter);
app.use('/api/spot', authMiddleware, spotTradeRoutes);
app.use('/api/futures', authMiddleware, futuresTradeRoutes);
app.use('/api/transfers', authMiddleware, transferRoutes);
app.use('/api/support', authMiddleware, supportRoutes(io));
app.use('/api/auth', authRoutes);
app.use('/api/coins', coinRoutes);
app.use('/api/profile-images', profileImagesRouter);
app.use('/api/assets', authMiddleware, assetRoutes);
app.use('/api/wallets', walletRoutes);
app.use('/api/ai-trades', aiTradeRoutes);
app.use('/api/luck-wheel', LuckWheelRouter);
app.use('/api/notifications', notification);
app.use('/api/referrals', authMiddleware, refferal);
app.use('/api/ai', authMiddleware, supportPredictionRoutes);
// Withdrawals (يوجد تمرير io داخل الراوتر نفسه)
app.use('/api/withdrawals', authMiddleware, withdrawalRouter);

// KYC
app.use('/api/kyc', authMiddleware, kycRoutes);

// Promotions
app.use('/api', promotionRoutes);
app.use('/api', promotionLeaderboardRoutes);

app.use(notFound);
app.use(errorHandler);

const PORT = process.env.PORT || 4000;
const mongoURI = process.env.MONGO_URI || '';

const connectWithRetry = async () => {
  try {
    // ملاحظة: useNewUrlParser/useUnifiedTopology لم تعد مطلوبة في Mongoose 7+
    await mongoose.connect(mongoURI, {
      connectTimeoutMS: 60000,
      serverSelectionTimeoutMS: 60000,
      socketTimeoutMS: 60000,
      maxPoolSize: 10,
      retryWrites: true,
      retryReads: true,
    });
    console.log('✅ Connected to MongoDB');
  } catch (error) {
    console.error('❌ MongoDB connection error:', error.message);
    console.log('Retrying MongoDB connection in 5 seconds...');
    setTimeout(connectWithRetry, 5000);
  }
};

const connectedUsers = new Map();
const updateSupportStatus = async () => {
  const supportOnline = Array.from(connectedUsers.values()).some((u) => u.role === 'Support');
  io.emit('support_status', { online: supportOnline });
};

const safeInit = async (label, fn) => {
  try {
    await fn();
    console.log(`✅ ${label} initialized`);
  } catch (e) {
    console.error(`⚠️ ${label} failed:`, e.message);
  }
};

const start = async () => {
  try {
    await connectWithRetry();

    mongoose.connection.on('error', (err) => console.error('MongoDB error:', err));
    mongoose.connection.on('disconnected', () => {
      console.log('MongoDB disconnected. Reconnecting...');
      connectWithRetry();
    });

    server.listen(PORT, () => console.log(`🚀 Server is running on port ${PORT}`));

    // Socket.io
    io.on('connection', async (socket) => {
      console.log('Client connected:', socket.id);

      socket.on('join', async ({ user_id }) => {
        if (user_id) {
          try {
            const user = await User.findById(user_id).select('role');
            if (user) {
              connectedUsers.set(socket.id, { userId: user_id, role: user.role });
              socket.join(String(user_id));
              await updateSupportStatus();
            }
          } catch (err) {
            console.error('Error fetching user role:', err.message);
          }
        }
      });

      socket.on('disconnect', async () => {
        connectedUsers.delete(socket.id);
        await updateSupportStatus();
      });
    });

    // Background services
    safeInit('Support WebSocket', () => initializeSupportWebSocket(server, io));
    safeInit('AI Price WebSocket', () => initializePriceWebSocket(io));
    safeInit('AI Schedule', () => schedulePredictionFetch(io));
    safeInit('Blockchain Watchers', () => startAllWatchers());

    setTimeout(() => {
      safeInit('Futures Price Feed', () => initFuturesPriceFeed());
      safeInit('Futures Engine', () => initFuturesEngine(io));
    }, Number(process.env.FUTURES_DELAY_MS || 500));
  } catch (error) {
    console.error(`❌ Failed to start server: ${error.message}`);
  }
};

start();

module.exports = { io };
