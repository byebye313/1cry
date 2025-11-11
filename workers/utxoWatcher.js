// workers/utxoWatcher.js
const axiosBase = require('axios');
const DepositIntent = require('../models/DepositIntent');
const { Deposit } = require('../models/Deposit');
const ProcessedTx = require('../models/ProcessedTx');
const { Asset } = require('../models/Asset');

// ========== إعدادات/ثوابت ==========
const REL_TOL = 0.01; // سماحية 1%
const ABS_TOL = 1e-6; // فرق مطلق صغير جداً
const GRACE_HOURS = Number(process.env.DEPOSIT_GRACE_HOURS || 24);

const SYMBOL_ALIASES = {
  BTC: ['BTC', 'Bitcoin'],
  LTC: ['LTC', 'LiteCoin', 'Litecoin'],
  BCH: ['BCH', 'Bitcoin Cash'],
  DASH: ['DASH', 'Dash'],
  DOGE: ['DOGE', 'DogeCoin', 'DOGECOIN', 'Doge'],
};

// ========== HTTP client + retry/backoff ==========
const http = axiosBase.create({
  timeout: Number(process.env.UTXO_HTTP_TIMEOUT || 12000),
  headers: { 'User-Agent': 'deposit-watcher/1.0' },
});

function shouldRetry(error) {
  if (!error || !error.response) return true; // network/timeout/DNS
  const s = error.response.status;
  return (s >= 500 && s < 600) || s === 429;
}

async function withRetry(fn, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (!shouldRetry(e)) break;
      const delay = 500 * Math.pow(2, i); // 500ms, 1000ms, 2000ms
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw last;
}

// ========== Endpoints ==========
const SOCHAIN = (sym) =>
  `${process.env[`${sym}_API`] || 'https://sochain.com/api/v2'}`;

const BLOCKCYPHER = (sym) => {
  // ملاحظة: BlockCypher لا يدعم BCH main رسميًا الآن؛ استخدم بديل لاحقًا إن احتجت BCH production.
  const map = { BTC: 'btc', LTC: 'ltc', DOGE: 'doge', DASH: 'dash', BCH: 'bcy' };
  return `https://api.blockcypher.com/v1/${map[sym] || 'ltc'}/main`;
};
const BC_TOKEN = process.env.BLOCKCYPHER_TOKEN || '';

// ========== دوال مساعدة ==========
function relDiff(a, b) {
  const A = Number(a),
    B = Number(b);
  const denom = Math.max(Math.abs(A), 1e-12);
  return Math.abs(A - B) / denom;
}

function isAmountAcceptable(expected, received) {
  const rd = relDiff(expected, received);
  if (rd <= REL_TOL) return true;
  if (Math.abs(expected - received) <= ABS_TOL) return true; // للمبالغ الصغيرة جداً
  return false;
}

function pickBestIntent(intentsForAddress, received) {
  let best = null;
  let bestScore = Infinity;
  for (const it of intentsForAddress) {
    const E = Number(it.expected_amount);
    if (!isAmountAcceptable(E, received)) continue;
    const score = relDiff(E, received);
    if (score < bestScore) {
      best = it;
      bestScore = score;
    }
  }
  return best; // null لو لا يوجد مطابق ضمن السماحية
}

// ========== مصادر البيانات (SoChain أولاً ثم BlockCypher كاحتياطي) ==========
async function fetchFromSoChain(symbol, address) {
  const map = { BTC: 'BTC', LTC: 'LTC', BCH: 'BCH', DASH: 'DASH', DOGE: 'DOGE' };
  const net = map[symbol];
  const url = `${SOCHAIN(symbol)}/get_tx_received/${net}/${address}`;
  const { data } = await withRetry(() => http.get(url));
  const txs = data?.data?.txs || [];
  return txs.map((t) => ({ txid: t.txid, value: Number(t.value || 0) })); // value بوحدة العملة
}

// BlockCypher: /addrs/{addr}/full — سنجمع كل المخرجات التي تخص العنوان
async function fetchFromBlockCypher(symbol, address) {
  const base = BLOCKCYPHER(symbol);
  const suffix = BC_TOKEN ? `?token=${BC_TOKEN}` : '';
  const url = `${base}/addrs/${address}/full${suffix}`;
  const { data } = await withRetry(() => http.get(url));
  const out = [];
  const txs = data?.txs || [];
  for (const tx of txs) {
    const txid = tx.hash;
    let receivedSats = 0;
    for (const o of tx.outputs || []) {
      const addrs = o.addresses || [];
      if (addrs.includes(address)) {
        receivedSats += Number(o.value || 0); // satoshis
      }
    }
    if (receivedSats > 0) {
      out.push({ txid, value: receivedSats / 1e8 }); // coin units
    }
  }
  return out;
}

async function fetchAddressTxs(symbol, address) {
  try {
    return await fetchFromSoChain(symbol, address);
  } catch (e) {
    console.warn(
      `[UTXO][${symbol}] SoChain failed for ${address}:`,
      e?.message || e
    );
    try {
      return await fetchFromBlockCypher(symbol, address);
    } catch (e2) {
      console.error(
        `[UTXO][${symbol}] BlockCypher failed for ${address}:`,
        e2?.message || e2
      );
      throw e2;
    }
  }
}

// ========== حلقة المسح ==========
async function tick() {
  try {
    const coins = ['BTC', 'LTC', 'BCH', 'DASH', 'DOGE'];

    for (const symbol of coins) {
      // Pending دائماً + Expired ضمن نافذة GRACE_HOURS
      const intents = await DepositIntent.find({
        asset_symbol: { $in: SYMBOL_ALIASES[symbol] || [symbol] },
        $or: [
          { status: 'Pending' },
          {
            status: 'Expired',
            expires_at: {
              $gte: new Date(Date.now() - GRACE_HOURS * 60 * 60 * 1000),
            },
          },
        ],
      })
        .select(
          'deposit_address expected_amount network_name user_id spot_wallet_id status expires_at createdAt'
        )
        .lean();

      if (!intents.length) continue;

      // عنون -> intents (نقدّم Pending على Expired)
      const byAddr = new Map();
      for (const it of intents) {
        const list = byAddr.get(it.deposit_address) || [];
        list.push(it);
        byAddr.set(it.deposit_address, list);
      }

      for (const [addr, listAll] of byAddr.entries()) {
        const ordered = [
          ...listAll.filter((i) => i.status === 'Pending'),
          ...listAll.filter((i) => i.status === 'Expired'),
        ];

        let txs = [];
        try {
          txs = await fetchAddressTxs(symbol, addr);
        } catch (e) {
          // فشل كل المزوّدين لهذا العنوان الآن — انتقل للعنوان التالي
          continue;
        }
        if (!txs?.length) continue;

        for (const tx of txs) {
          // تجاهل إن سبق معالجته
          const exists = await ProcessedTx.findOne({ tx_hash: tx.txid });
          if (exists) continue;

          const received = Number(tx.value || 0);
          if (received <= 0) continue;

          // اختر أفضل Intent (ضمن ±1%)
          const chosen = pickBestIntent(ordered, received);
          if (!chosen) continue;

          const asset = await Asset.findOne({ symbol });
          await Deposit.create({
            user_id: chosen.user_id,
            spot_wallet_id: chosen.spot_wallet_id,
            asset_id: asset?._id,
            amount: received,
            status: 'Pending',
          });

          await DepositIntent.updateOne(
            { _id: chosen._id },
            {
              $set: {
                status: 'Matched',
                matched_tx_hash: tx.txid,
                matched_at: new Date(),
              },
            }
          );

          await ProcessedTx.create({
            tx_hash: tx.txid,
            address: addr,
            network_key: symbol.toLowerCase(),
          });

          // لوج اختياري للتتبع
          console.log(
            `[UTXO][${symbol}] Matched intent ${chosen._id} addr=${addr} tx=${tx.txid} amount=${received}`
          );

          // احذف الـ chosen من القائمة حتى لا يُستخدم مرة أخرى
          const idx = ordered.findIndex(
            (i) => String(i._id) === String(chosen._id)
          );
          if (idx >= 0) ordered.splice(idx, 1);
        }
      }
    }
  } catch (e) {
    console.error('UTXO tick error:', e.message);
  }
}

// ========== تشغيل المؤقت ==========
function startUtxoWatcher() {
  const interval = Number(
    process.env.UTXO_POLL_MS || process.env.POLL_INTERVAL_MS || 20000
  );
  setInterval(tick, interval);
  console.log('UTXO watcher started, interval =', interval, 'ms');
}

module.exports = { startUtxoWatcher };
