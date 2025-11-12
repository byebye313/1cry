// app.js (Production-hardened)
// - CORS from ENV, single middleware
// - Helmet + Compression + Rate-limit
// - Smaller JSON body limits
// - trust proxy (for reverse proxies)
// - Graceful shutdown
// - Dynamic Spot Price Hub + Futures Engine/PriceFeed

require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const http = require('http');
const path = require('path');
const cors = require('cors'); // استخدمناه فقط لو أردت الاحتفاظ به لاحقاً؛ لكن نعتمد الميدل وير اليدوي الموحّد
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const { Server } = require('socket.io');

// Middlewares (خاصة بك)
const { notFound, errorHandler } = require('./middlewares/errorHandler');
const { logger } = require('./middlewares/logger');
const authMiddleware = require('./middlewares/authMiddleware');

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
const supportPredictionRoutes  = require('./routes/supportPredictionRoutes');
const promotionRoutes = require('./routes/promotionRoutes');
const promotionLeaderboardRoutes = require('./routes/promotionLeaderboardRoutes'); // اختياري

// Other services
const { startAllWatchers } = require('./workers/poller');
const { initializeSupportWebSocket } = require('./services/supportService');
const { initializePriceWebSocket, schedulePredictionFetch } = require('./services/aiTradeService');
const { User } = require('./models/user');

// Spot hub (ديناميكي للأوامر المعلقة فقط)
const { initializeWebSockets: initSpotPriceHub } = require('./services/binanceServices');

// Futures services (ديناميكي للصفقات المفتوحة فقط)
const { initFuturesEngine } = require('./services/futuresEngine');
const { initFuturesPriceFeed } = require('./services/futuresPriceFeed');

const app = express();
const server = http.createServer(app);

// ===== Socket.IO =====
const io = new Server(server, {
  cors: {
    origin: (origin, cb) => {
      // سنعتمد فحص الأصل في الميدل وير الموحّد أدناه أيضاً
      cb(null, true);
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    credentials: true,
  },
});
app.set('io', io); // ليقرأه أي راوتر عبر req.app.get('io')

// ===== Express hardening =====
app.set('trust proxy', 1); // خلف Nginx/Cloudflare

// Helmet (مع سياسة للملفات الثابتة)
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
}));

// ضغط HTTP
app.use(compression());

// حدود أحجام الطلبات
app.use(express.json({ limit: '512kb' }));
app.use(express.urlencoded({ extended: true, limit: '512kb' }));

// لوجر خاص بك
app.use(logger);

// ===== CORS موحّد من ENV =====
const ALLOWED = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// helper
const isAllowed = (origin) => !origin || ALLOWED.includes(origin);

// ميدل وير موحّد يضبط كل الهيدرز + يمرر io
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (isAllowed(origin)) res.header('Access-Control-Allow-Origin', origin || '*');
  res.header('Vary', 'Origin');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') return res.status(204).end();
  req.io = io;
  next();
});

// ===== Rate limits على مسارات حساسة =====
const authLimiter = rateLimit({ windowMs: 60_000, max: 60 });
app.use('/api/auth', authLimiter);
app.use('/api/kyc', authLimiter);

// ===== Static (public + user uploads) =====
app.use(express.static(path.join(__dirname, 'public')));
app.use('/ProfileImages', express.static(path.join(__dirname, 'ProfileImages')));
app.use('/uploadedProfile', express.static(path.join(__dirname, 'uploadedProfile')));

// KYC / uploads في جذر المشروع (تأكد من إدارة الوصول لاحقاً إذا لزم)
app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')));

// Healthcheck
app.get('/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime(), pid: process.pid, time: new Date().toISOString() });
});

// ===== Routes =====
// ملاحظة: بعض الراوترات تحتاج authMiddleware
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
app.use('/api/withdrawals', authMiddleware, withdrawalRouter); // يحتوي تمرير io داخلياً
app.use('/api', promotionRoutes);
app.use('/api', promotionLeaderboardRoutes);

// Errors
app.use(notFound);
app.use(errorHandler);

// ===== Mongo =====
mongoose.set('strictQuery', false);
const PORT = process.env.PORT || 4000;
const mongoURI = process.env.MONGO_URI || 'mongodb://localhost:27017/trading_platform';

const connectWithRetry = async () => {
  try {
    await mongoose.connect(mongoURI, {
      // هذه الخيارات ليست ضرورية مع Mongoose >= 7، لكن آمنة
      connectTimeoutMS: 60_000,
      serverSelectionTimeoutMS: 60_000,
      socketTimeoutMS: 60_000,
      maxPoolSize: Number(process.env.MONGO_MAX_POOL || 10),
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

// ===== Socket.io presence (Support online indicator) =====
const { User: UserModel } = require('./models/user'); // تأكيد الاستيراد الصحيح
const connectedUsers = new Map();

const updateSupportStatus = async () => {
  const supportOnline = Array.from(connectedUsers.values()).some((u) => u.role === 'Support');
  io.emit('support_status', { online: supportOnline });
};

// ===== Helpers =====
const safeInit = async (label, fn) => {
  try {
    await fn();
    console.log(`✅ ${label} initialized`);
  } catch (e) {
    console.error(`⚠️ ${label} failed:`, e.message);
  }
};

// ===== Start =====
const start = async () => {
  try {
    await connectWithRetry();

    mongoose.connection.on('error', (err) => console.error('MongoDB error:', err));
    mongoose.connection.on('disconnected', () => {
      console.log('MongoDB disconnected. Reconnecting...');
      connectWithRetry();
    });

    server.listen(PORT, () => console.log(`🚀 Server is running on port ${PORT}`));

    // Socket.io handlers
    io.on('connection', async (socket) => {
      console.log('Client connected:', socket.id);

      socket.on('join', async ({ user_id }) => {
        if (user_id) {
          try {
            const user = await UserModel.findById(user_id).select('role');
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
    safeInit('Spot Price Hub', () => initSpotPriceHub(io)); // ديناميكي للأوامر المعلقة

    // أخر تشغيل الفيوتشر قليلاً بعد اتصال Mongo واستقرار السيرفر
    setTimeout(() => {
      safeInit('Futures Price Feed', () => initFuturesPriceFeed()); // يبدأ فارغاً: watch/unwatch فقط
      safeInit('Futures Engine', () => initFuturesEngine(io));      // حلقة فحص TP/SL/Liq + تنفيذ Limit
    }, Number(process.env.FUTURES_DELAY_MS || 500));
  } catch (error) {
    console.error(`❌ Failed to start server: ${error.message}`);
  }
};

start();

// ===== Graceful shutdown =====
const shutdown = (signal) => {
  console.log(`${signal} received, shutting down...`);
  server.close(() => {
    mongoose.connection.close(false, () => process.exit(0));
  });
};
['SIGINT','SIGTERM'].forEach(sig => process.on(sig, () => shutdown(sig)));
process.on('uncaughtException', err => { console.error(err); process.exit(1); });
process.on('unhandledRejection', err => { console.error(err); process.exit(1); });

module.exports = { io };
