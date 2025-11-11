// controllers/withdrawalController.js
const mongoose = require("mongoose");
const axios = require("axios");
const {
  WithdrawalRequest,
  validateCreateWithdrawal,
} = require("../models/WithdrawalRequest");
const { User } = require("../models/user");
const { Asset } = require("../models/Asset");
const { SpotWalletBalance } = require("../models/SpotWalletBalance");
const { sendMailWithLogoSafe } = require("../services/mailer");
const tpl = require("../services/emailTemplates/withdrawal");

const FEE_USDT = Number(process.env.WITHDRAW_FEE_USDT || 5);
const NETWORK_FEE_PCT = 0.01; // 1% (لغير USDT)
const ALLOWED_NETWORKS = ["TRC20", "ERC20", "BEP20", "BTC", "LTC", "XRP"];

const toObjectId = (v) =>
  v && mongoose.Types.ObjectId.isValid(v)
    ? new mongoose.Types.ObjectId(v)
    : null;

function normalizeAssetSymbol(input) {
  let s = String(input || "").trim().toUpperCase();
  s = s.replace("-", "");
  if (s === "USDT") return "USDT";
  if (s.endsWith("USDT") && s.length > 4) return s.slice(0, -4);
  return s;
}

async function getUserSafe(req) {
  const id = req?.user?._id || req?.user?.id || req?.userId || req?.auth?.userId || null;
  let user = null;
  if (id && mongoose.Types.ObjectId.isValid(id)) {
    user = await User.findById(id).select("_id username email spot_wallet").lean();
  }
  if (!user && req?.user?.email) {
    user = await User.findOne({ email: String(req.user.email).toLowerCase() })
      .select("_id username email spot_wallet")
      .lean();
  }
  return user;
}

function isSupport(req) {
  const role = String(req?.user?.role || req?.user?.Role || "").toLowerCase();
  return role === "support" || role === "staff" || role === "admin_support";
}

const n = (x, d = 8) => Number(x ?? 0).toFixed(d);

async function fetchPriceUSDT(baseSymbol) {
  if (baseSymbol === "USDT") return 1;
  const base = normalizeAssetSymbol(baseSymbol);

  // 1) Binance
  try {
    const { data } = await axios.get("https://api.binance.com/api/v3/ticker/price", {
      params: { symbol: `${base}USDT` },
      timeout: 5000,
    });
    const p = Number(data?.price);
    if (Number.isFinite(p) && p > 0) return p;
  } catch {}

  // 2) Binance inverse (USDTBASE)
  try {
    const { data } = await axios.get("https://api.binance.com/api/v3/ticker/price", {
      params: { symbol: `USDT${base}` },
      timeout: 5000,
    });
    const p = Number(data?.price);
    if (Number.isFinite(p) && p > 0) return 1 / p;
  } catch {}

  // 3) CoinGecko (USD≈USDT)
  try {
    const idMap = { BTC: "bitcoin", ETH: "ethereum", XRP: "ripple", LTC: "litecoin", TRX: "tron", BNB: "binancecoin" };
    const id = idMap[base];
    if (id) {
      const { data } = await axios.get("https://api.coingecko.com/api/v3/simple/price", {
        params: { ids: id, vs_currencies: "usd" },
        timeout: 5000,
      });
      const p = Number(data?.[id]?.usd);
      if (Number.isFinite(p) && p > 0) return p;
    }
  } catch {}

  // 4) Env fallback
  const env = Number(process.env[`FALLBACK_PRICE_${base}`]);
  if (Number.isFinite(env) && env > 0) return env;

  throw new Error(`Price unavailable for ${base}USDT`);
}

// Platform fee (5 USDT) + 1% network fee for non-USDT
async function computeFeesAndNet(assetSymbolRaw, amount) {
  const base = normalizeAssetSymbol(assetSymbolRaw);
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) throw new Error("Invalid amount");

  const priceUSDT = await fetchPriceUSDT(base);

  const platform_fee_usdt = FEE_USDT;
  const platform_fee_asset = base === "USDT" ? FEE_USDT : FEE_USDT / priceUSDT;
  const network_fee_pct = base === "USDT" ? 0 : NETWORK_FEE_PCT;
  const network_fee_asset = base === "USDT" ? 0 : amt * NETWORK_FEE_PCT;

  const total_fee_asset = platform_fee_asset + network_fee_asset;
  const net_amount = Math.max(0, amt - total_fee_asset);

  return {
    price_usdt: Number(n(priceUSDT, 8)),
    platform_fee_usdt: Number(n(platform_fee_usdt, 2)),
    platform_fee_asset: Number(n(platform_fee_asset, 8)),
    network_fee_pct: network_fee_pct,
    network_fee_asset: Number(n(network_fee_asset, 8)),
    total_fee_asset: Number(n(total_fee_asset, 8)),
    net_amount: Number(n(net_amount, 8)),
  };
}

/* ========================= Controllers ========================= */

// GET /api/withdrawals/fee-quote?asset_symbol=BTC&amount=0.5
exports.getFeeQuote = async (req, res) => {
  try {
    const baseSymbol = normalizeAssetSymbol(req.query.asset_symbol || "");
    const amount = Number(req.query.amount || 0);
    if (!baseSymbol || !amount) {
      return res.status(400).json({ message: "asset_symbol & amount are required" });
    }
    const out = await computeFeesAndNet(baseSymbol, amount);
    return res.json(out);
  } catch (e) {
    console.error("[fee-quote]", e?.message || e);
    return res.status(500).json({ message: "Failed to quote fee" });
  }
};

// POST /api/withdrawals
exports.createWithdrawal = async (req, res) => {
  try {
    const { error, value } = validateCreateWithdrawal(req.body);
    if (error) return res.status(400).json({ message: error.details[0].message });

    const { asset_symbol, network, to_address, amount } = value;
    if (!ALLOWED_NETWORKS.includes(network)) {
      return res.status(400).json({ message: "Network not supported" });
    }

    const dbUser = await getUserSafe(req);
    if (!dbUser) return res.status(401).json({ message: "User not found / unauthorized" });

    const spotWalletId = toObjectId(dbUser.spot_wallet);
    if (!spotWalletId) {
      return res.status(400).json({ message: "Spot wallet not linked to your account" });
    }

    const baseSymbol = normalizeAssetSymbol(asset_symbol);

    const asset = await Asset.findOne({ symbol: baseSymbol });
    if (!asset) return res.status(400).json({ message: "Asset not supported" });
    if (asset.is_deposit_enabled === false) {
      return res.status(400).json({ message: `Deposits are disabled for ${baseSymbol}` });
    }

    // === KYC gate (> 56 USDT) BEFORE reserving balance ===
    try {
      const userKyc = await User.findById(dbUser._id).select('kyc_status').lean();
      const px = await fetchPriceUSDT(baseSymbol);
      const amountUSDT = Number(amount) * Number(px);
      if (amountUSDT > 56 && String(userKyc?.kyc_status) !== 'verified') {
        return res.status(403).json({
          code: 'KYC_REQUIRED',
          message: 'Please verify your account first to withdraw more than 56 USDT'
        });
      }
    } catch (kycErr) {
      // إذا فشل استدعاء السعر لأي سبب، لا نكسر العملية: نسمح بالمتابعة (أو يمكنك رفضها إن رغبت)
      // return res.status(500).json({ message: 'Failed to compute KYC threshold' });
    }

    // الرسوم + الصافي (يستلزم السعر)
    const quote = await computeFeesAndNet(baseSymbol, amount);

    if (baseSymbol === "USDT" && quote.net_amount <= 0) {
      return res.status(400).json({ message: `Amount must exceed platform fee (${FEE_USDT} USDT)` });
    }

    // تحقق وحجز الرصيد: نخصم "amount" بالكامل (net للعرض والحفظ فقط)
    const balanceDoc = await SpotWalletBalance.findOne({
      spot_wallet_id: spotWalletId,
      asset_id: asset._id,
    });
    if (!balanceDoc) {
      return res.status(400).json({ message: `No ${baseSymbol} balance found in Spot wallet` });
    }
    if (Number(balanceDoc.balance) < Number(amount)) {
      return res.status(400).json({
        message: "Insufficient balance in Spot wallet",
        available: Number(balanceDoc.balance),
        requested: Number(amount),
      });
    }

    const updated = await SpotWalletBalance.findOneAndUpdate(
      { _id: balanceDoc._id, balance: { $gte: Number(amount) } },
      { $inc: { balance: -Number(amount) } },
      { new: true }
    );
    if (!updated) return res.status(409).json({ message: "Please retry: balance changed" });

    const request = await WithdrawalRequest.create({
      user_id: dbUser._id,
      asset_symbol: baseSymbol,
      network,
      to_address,
      amount: Number(amount),
      price_usdt: quote.price_usdt,
      platform_fee_usdt: quote.platform_fee_usdt,
      platform_fee_asset: quote.platform_fee_asset,
      network_fee_pct: quote.network_fee_pct,
      network_fee_asset: quote.network_fee_asset,
      total_fee_asset: quote.total_fee_asset,
      net_amount: quote.net_amount,
      status: "Pending",
      history_notes: [{ note: "Created" }],
    });

    // بثّ لقسم الدعم
    req.io?.to("support").emit("withdrawal_new", { requestId: request._id });

    return res.status(201).json({ request });
  } catch (e) {
    console.error("[createWithdrawal]", e);
    return res.status(500).json({ message: "Internal error" });
  }
};

// GET /api/withdrawals/mine
exports.getMyWithdrawals = async (req, res) => {
  try {
    const dbUser = await getUserSafe(req);
    if (!dbUser) return res.status(401).json({ message: "User not found / unauthorized" });
    const list = await WithdrawalRequest.find({ user_id: dbUser._id }).sort({ created_at: -1 });
    return res.json({ requests: list });
  } catch (e) {
    console.error("[getMyWithdrawals]", e);
    return res.status(500).json({ message: "Internal error" });
  }
};

// GET /api/withdrawals  (Support)
exports.getAllWithdrawals = async (req, res) => {
  try {
    if (!isSupport(req)) return res.status(403).json({ message: "Forbidden" });
    const list = await WithdrawalRequest.find({})
      .populate("user_id", "username email created_at spot_wallet")
      .sort({ created_at: -1 });
    return res.json({ requests: list });
  } catch (e) {
    console.error("[getAllWithdrawals]", e);
    return res.status(500).json({ message: "Internal error" });
  }
};

// PATCH /api/withdrawals/:id/approve
exports.approveWithdrawal = async (req, res) => {
  try {
    if (!isSupport(req)) return res.status(403).json({ message: "Forbidden" });

    const { id } = req.params;
    const wr = await WithdrawalRequest.findById(id).populate("user_id", "username email");
    if (!wr) return res.status(404).json({ message: "Request not found" });
    if (wr.status !== "Pending") return res.status(400).json({ message: "Invalid status" });

    wr.status = "Approved";
    wr.history_notes.push({ note: `Approved by ${req.user._id}` });
    await wr.save();

    req.io?.to("support").emit("withdrawal_update", { id: String(wr._id), status: wr.status });
    req.io?.to(String(wr.user_id._id)).emit("withdrawal_status", { id: wr._id, status: wr.status });

    return res.json({ request: wr });
  } catch (e) {
    console.error("[approveWithdrawal]", e);
    return res.status(500).json({ message: "Internal error" });
  }
};

// PATCH /api/withdrawals/:id/reject
exports.rejectWithdrawal = async (req, res) => {
  try {
    if (!isSupport(req)) return res.status(403).json({ message: "Forbidden" });

    const { id } = req.params;
    const { reason } = req.body;

    const wr = await WithdrawalRequest.findById(id).populate("user_id", "username email spot_wallet");
    if (!wr) return res.status(404).json({ message: "Request not found" });
    if (!["Pending", "Approved"].includes(wr.status)) {
      return res.status(400).json({ message: "Invalid status" });
    }

    const asset = await Asset.findOne({ symbol: wr.asset_symbol });
    const spotWalletId = toObjectId(wr.user_id.spot_wallet);
    if (!spotWalletId) return res.status(400).json({ message: "Invalid user Spot wallet reference" });

    // إعادة كامل المبلغ المحجوز
    await SpotWalletBalance.findOneAndUpdate(
      { spot_wallet_id: spotWalletId, asset_id: asset._id },
      { $inc: { balance: Number(wr.amount) } },
      { upsert: true, new: true }
    );

    wr.status = "Rejected";
    wr.reject_reason = reason || "N/A";
    wr.history_notes.push({ note: `Rejected by ${req.user._id}: ${wr.reject_reason}` });
    await wr.save();

    req.io?.to("support").emit("withdrawal_update", { id: String(wr._id), status: wr.status, reason: wr.reject_reason });
    req.io?.to(String(wr.user_id._id)).emit("withdrawal_status", { id: wr._id, status: wr.status });

    return res.json({ request: wr });
  } catch (e) {
    console.error("[rejectWithdrawal]", e);
    return res.status(500).json({ message: "Internal error" });
  }
};

// PATCH /api/withdrawals/:id/complete (Email notify)
exports.completeWithdrawal = async (req, res) => {
  try {
    if (!isSupport(req)) return res.status(403).json({ message: "Forbidden" });

    const { id } = req.params;
    const wr = await WithdrawalRequest.findById(id).populate("user_id", "username email");
    if (!wr) return res.status(404).json({ message: "Request not found" });
    if (wr.status !== "Approved") return res.status(400).json({ message: "Invalid status" });

    wr.status = "Completed";
    wr.history_notes.push({ note: `Completed by ${req.user._id}` });
    await wr.save();

    const APP_URL = (process.env.APP_URL || process.env.CLIENT_URL || "http://localhost:3000").replace(/\/+$/, "");
    const requestUrl = `${APP_URL}/withdrawals/${wr._id}`;

    const mail = await sendMailWithLogoSafe({
      to: wr.user_id.email,
      subject: `Your ${wr.asset_symbol} withdrawal is completed`,
      html: tpl.completed({
        brandName: "1CryptoX",
        username: wr.user_id.username || wr.user_id.email,
        asset: wr.asset_symbol,
        amount: wr.amount,
        network: wr.network,
        to: wr.to_address,
        requestId: wr._id,
        completedAt: new Date().toISOString(),
        feeUSDT: wr.platform_fee_usdt ?? FEE_USDT,
        feeAsset: wr.platform_fee_asset ?? null,
        networkFeePct: wr.network_fee_pct ?? 0,
        networkFeeAsset: wr.network_fee_asset ?? 0,
        totalFeeAsset: wr.total_fee_asset ?? 0,
        netAmount: wr.net_amount,
        requestUrl,
      }),
      category: "withdrawal_completed",
    });

    await WithdrawalRequest.findByIdAndUpdate(wr._id, {
      $push: {
        history_notes: {
          note: mail.ok ? `Email(complete) sent: ${mail.info.messageId}` : `Email(complete) failed: ${mail.error}`,
        },
      },
    });

    req.io?.to("support").emit("withdrawal_update", { id: String(wr._id), status: wr.status });
    req.io?.to(String(wr.user_id._id)).emit("withdrawal_status", { id: wr._id, status: wr.status });

    return res.json({ request: wr });
  } catch (e) {
    console.error("[completeWithdrawal]", e);
    return res.status(500).json({ message: "Internal error" });
  }
};
