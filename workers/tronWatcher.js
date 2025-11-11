// const axios = require('axios');
// const DepositIntent = require('../models/DepositIntent');
// const { Deposit } = require('../models/Deposit');
// const ProcessedTx = require('../models/ProcessedTx');
// const {Asset} = require('../models/Asset');

// const tron = axios.create({ baseURL: process.env.TRON_GRID || 'https://api.trongrid.io' });


// tron.interceptors.request.use(cfg => {
//   if (process.env.TRON_API_KEY) {
//     cfg.headers['TRON-PRO-API-KEY'] = process.env.TRON_API_KEY;
//   }
//   return cfg;
// });

// async function matchCreateDeposit({ symbol, address, amount, tx_hash }) {
//   const exists = await ProcessedTx.findOne({ tx_hash });
//   if (exists) return false;

//   const intent = await DepositIntent.findOne({
//     deposit_address: address, asset_symbol: symbol, network_name: 'Tron TRC-20', status: 'Pending'
//   }).sort({ createdAt: 1 });
//   if (!intent) return false;

//   if (String(Number(intent.expected_amount)) !== String(Number(amount))) return false;

//   intent.status = 'Matched';
//   intent.matched_tx_hash = tx_hash;
//   intent.matched_at = new Date();
//   await intent.save();

//   const asset = await Asset.findOne({ symbol });
//   await Deposit.create({
//     user_id: intent.user_id, spot_wallet_id: intent.spot_wallet_id, asset_id: asset?._id,
//     amount: Number(amount), status: 'Pending'
//   });

//   await ProcessedTx.create({ tx_hash, address, network_key: 'tron' });
//   return true;
// }

// async function tick() {
//   try {
//     // TRC-20
//     const intents = await DepositIntent.find({ status: 'Pending', network_name: 'Tron TRC-20' })
//       .select('deposit_address asset_symbol');
//     const uniq = [...new Set(intents.map(i => `${i.asset_symbol}|${i.deposit_address}`))];

//     for (const key of uniq) {
//       const [symbol, address] = key.split('|');
//       const { data } = await tron.get(`/v1/accounts/${address}/transactions/trc20?only_confirmed=true&limit=50`);
//       const txs = data?.data || [];
//       for (const tx of txs) {
//         if (tx.type !== 'Transfer') continue;
//         if (tx.to !== address) continue;
//         const amount = Number(tx.value) / (10 ** 6); // USDT TRC-20 غالبًا 6
//         await matchCreateDeposit({ symbol, address, amount, tx_hash: tx.transaction_id });
//       }
//     }

//     // TRX native (اختياري إذا لديك TRX في wallet.js)
//     const trxIntents = await DepositIntent.find({ status: 'Pending', asset_symbol: 'TRX' })
//       .select('deposit_address');
//     const addrs = [...new Set(trxIntents.map(i => i.deposit_address))];
//     for (const address of addrs) {
//       const { data } = await tron.get(`/v1/accounts/${address}/transactions?only_confirmed=true&limit=50`);
//       const txs = data?.data || [];
//       for (const tx of txs) {
//         if (tx.to !== address) continue;
//         const amount = Number(tx.value) / (10 ** 6);
//         await matchCreateDeposit({ symbol: 'TRX', address, amount, tx_hash: tx.txID || tx.hash });
//       }
//     }
//   } catch (e) {
//     console.error('TRON tick error', e.message);
//   }
// }

// function startTronWatcher() {
//   const interval = Number(process.env.POLL_INTERVAL_MS || 15000);
//   setInterval(tick, interval);
//   console.log('TRON watcher started');
// }

// module.exports = { startTronWatcher };




// workers/tronWatcher.js
const axiosBase = require('axios');
const DepositIntent = require('../models/DepositIntent');
const { Deposit } = require('../models/Deposit');
const ProcessedTx = require('../models/ProcessedTx');
const { Asset } = require('../models/Asset');

// =================== إعدادات عامة ===================
const REL_TOL = 0.01; // ±1% سماحية
const ABS_TOL = 1e-6; // هامش مطلق صغير جداً
const GRACE_HOURS = Number(process.env.DEPOSIT_GRACE_HOURS || 24);

// لو تحب تضيف رموز TRC20 أخرى لاحقًا، زِدها هنا.
// العقد الافتراضي لـ USDT-TRC20 يمكن تعديله من الـ .env
// TRC20_USDT_CONTRACT=TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t
const TRON_TOKENS = {
  USDT: {
    contract: process.env.TRC20_USDT_CONTRACT || 'TSu4wFfrJLM8YmTznvSYxecb6fo6mfMaHT',
    decimals: Number(process.env.TRC20_USDT_DECIMALS || 6),
  },
  // مثال لإضافة رمز آخر:
  // USDC: { contract: process.env.TRC20_USDC_CONTRACT || '...', decimals: 6 }
};

// أسماء بديلة (لو فرونتك خزّن الاسم بشكل مختلف)
const SYMBOL_ALIASES = {
  USDT: ['USDT', 'Tether', 'Tether USD'],
  TRX:  ['TRX']
};

// =================== HTTP Clients + Retry/Fallback ===================
const tron = axiosBase.create({
  baseURL: process.env.TRON_GRID || 'https://api.trongrid.io',
  timeout: Number(process.env.TRON_HTTP_TIMEOUT || 12000),
  headers: { 'User-Agent': 'deposit-watcher/1.0' },
});

tron.interceptors.request.use((cfg) => {
  if (process.env.TRON_API_KEY) {
    cfg.headers['TRON-PRO-API-KEY'] = process.env.TRON_API_KEY;
  }
  return cfg;
});

// Fallback عام (TronScan الرسمي)
const tronscan = axiosBase.create({
  baseURL: process.env.TRONSCAN_API || 'https://apilist.tronscanapi.com',
  timeout: Number(process.env.TRON_HTTP_TIMEOUT || 12000),
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
    try { return await fn(); } catch (e) {
      last = e;
      if (!shouldRetry(e)) break;
      const delay = 500 * Math.pow(2, i); // 500ms, 1000ms, 2000ms
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw last;
}

// =================== Helpers ===================
function relDiff(a, b) {
  const A = Number(a), B = Number(b);
  const denom = Math.max(Math.abs(A), 1e-12);
  return Math.abs(A - B) / denom;
}
function isAmountAcceptable(expected, received) {
  const rd = relDiff(expected, received);
  if (rd <= REL_TOL) return true;
  if (Math.abs(expected - received) <= ABS_TOL) return true;
  return false;
}
function pickBestIntent(intentsForAddress, received) {
  let best = null, bestScore = Infinity;
  for (const it of intentsForAddress) {
    const E = Number(it.expected_amount);
    if (!isAmountAcceptable(E, received)) continue;
    const score = relDiff(E, received);
    if (score < bestScore) { best = it; bestScore = score; }
  }
  return best;
}

function symbolMatches(sym, target) {
  const al = SYMBOL_ALIASES[target] || [target];
  return al.includes(sym);
}

// =================== TronGrid & TronScan fetchers ===================
// 1) TronGrid: /v1/accounts/{address}/transactions/trc20?only_confirmed=true&limit=50
async function fetchTRC20_Account(address) {
  const url = `/v1/accounts/${address}/transactions/trc20?only_confirmed=true&limit=50`;
  const { data } = await withRetry(() => tron.get(url));
  return (data?.data || []).map((tx) => ({
    txid: tx.transaction_id,
    contract: tx.contract_address,   // Base58
    to: tx.to,
    valueRaw: tx.value,              // string raw (no decimals)
    type: tx.type,                   // 'Transfer' عادةً
  }));
}

// 2) TronScan fallback: /api/token_trc20/transfers?limit=50&toAddress=...&contract=...
async function fetchTRC20_TronScan(address, contract) {
  const url = `/api/token_trc20/transfers?limit=50&toAddress=${address}&contract=${contract}`;
  const { data } = await withRetry(() => tronscan.get(url));
  const list = data?.token_transfers || data?.data || data?.transfers || [];
  return list.map((tx) => ({
    txid: tx.transaction_id || tx.transactionId || tx.hash,
    contract: tx.contract || tx.contract_address,
    to: tx.to_address || tx.to,
    valueRaw: tx.quant || tx.value, // raw (بدون تقسيم على decimals)
    type: 'Transfer',
  }));
}

// موحّد: حاول TronGrid أولًا، ثم TronScan
async function fetchTRC20(address, contract) {
  try {
    const rows = await fetchTRC20_Account(address);
    // إن كانت TronGrid لا ترجع العقد في بعض الحلات، سنصفّي لاحقًا
    return rows;
  } catch (e) {
    console.warn('[TRON] TronGrid failed, trying TronScan:', e?.message || e);
    try {
      return await fetchTRC20_TronScan(address, contract);
    } catch (e2) {
      console.error('[TRON] TronScan failed:', e2?.message || e2);
      throw e2;
    }
  }
}

// TRX native (اختياري)
async function fetchTRX_In(address) {
  const url = `/v1/accounts/${address}/transactions?only_confirmed=true&limit=50`;
  const { data } = await withRetry(() => tron.get(url));
  return (data?.data || []).map((tx) => ({
    txid: tx.txID || tx.hash,
    to: tx.to,
    amountSun: tx.value, // SUN (1e6)
  }));
}

// =================== مطابقة وإنشاء الإيداع ===================
async function createDepositFromIntent(intent, amount, tx_hash) {
  const exists = await ProcessedTx.findOne({ tx_hash });
  if (exists) return false;

  const asset = await Asset.findOne({ symbol: intent.asset_symbol });
  await Deposit.create({
    user_id: intent.user_id,
    spot_wallet_id: intent.spot_wallet_id,
    asset_id: asset?._id,
    amount: Number(amount),
    status: 'Pending',
  });

  await DepositIntent.updateOne(
    { _id: intent._id },
    { $set: { status: 'Matched', matched_tx_hash: tx_hash, matched_at: new Date() } }
  );

  await ProcessedTx.create({ tx_hash, address: intent.deposit_address, network_key: 'tron' });

  console.log(`[TRON] Matched intent ${intent._id} addr=${intent.deposit_address} tx=${tx_hash} amount=${amount}`);
  return true;
}

// =================== الحلقة الرئيسية ===================
async function tick() {
  try {
    // --- TRC20 (مثل USDT) ---
    // نجلب كل Intent بالحالة Pending + Expired ضمن نافذة سماح، للشبكة Tron TRC-20
    const trc20Intents = await DepositIntent.find({
      network_name: 'Tron TRC-20',
      $or: [
        { status: 'Pending' },
        { status: 'Expired', expires_at: { $gte: new Date(Date.now() - GRACE_HOURS * 60 * 60 * 1000) } }
      ]
    })
    .select('deposit_address asset_symbol expected_amount status user_id spot_wallet_id expires_at createdAt')
    .lean();

    if (trc20Intents.length) {
      // عنونة: symbol -> (contract, decimals)
      // نركّز على الرموز المعرفة في TRON_TOKENS فقط
      const groupsBySymbol = new Map();
      for (const it of trc20Intents) {
        // حدد الرمز الحقيقي (USDT مثلاً) عبر aliases
        let trueSymbol = null;
        for (const key of Object.keys(TRON_TOKENS)) {
          if (symbolMatches(it.asset_symbol, key)) { trueSymbol = key; break; }
        }
        if (!trueSymbol) continue; // رمز غير معرّف لدينا على TRON

        const meta = TRON_TOKENS[trueSymbol];
        const arr = groupsBySymbol.get(trueSymbol) || [];
        arr.push({ ...it, _meta: meta });
        groupsBySymbol.set(trueSymbol, arr);
      }

      // لكل رمز (مثل USDT)، اجلب التحويلات لكل عنوان مرة واحدة
      for (const [trueSymbol, list] of groupsBySymbol.entries()) {
        const { contract, decimals } = TRON_TOKENS[trueSymbol];

        // عناوين فريدة
        const byAddr = new Map();
        for (const it of list) {
          const arr = byAddr.get(it.deposit_address) || [];
          arr.push(it);
          byAddr.set(it.deposit_address, arr);
        }

        for (const [addr, intentsForAddrAll] of byAddr.entries()) {
          // pending أولاً ثم expired
          const ordered = [
            ...intentsForAddrAll.filter(i => i.status === 'Pending'),
            ...intentsForAddrAll.filter(i => i.status === 'Expired'),
          ];

          let rows = [];
          try {
            rows = await fetchTRC20(addr, contract);
          } catch {
            continue; // فشل كل المزوّدين لهذا العنوان الآن
          }
          if (!rows?.length) continue;

          // صفِّ فقط التحويلات إلى عنواننا ومن العقد الصحيح
          const transfers = rows.filter(r =>
            String(r.type).toLowerCase() === 'transfer' &&
            r.to === addr &&
            (!r.contract || r.contract === contract) // TronGrid قد لا يرجّع contract دائماً، TronScan يرجّعه
          );

          for (const tx of transfers) {
            const txid = tx.txid;
            // تجاهل لو سبق معالجته
            const exists = await ProcessedTx.findOne({ tx_hash: txid });
            if (exists) continue;

            // حساب القيمة بالوحدة الطبيعية (USDT)
            const raw = String(tx.valueRaw || '0').trim();
            if (!raw || raw === '0') continue;
            const amount = Number(raw) / Math.pow(10, decimals);

            // اختر أفضل Intent (±1%)
            const chosen = pickBestIntent(ordered, amount);
            if (!chosen) continue;

            await createDepositFromIntent(chosen, amount, txid);

            // إزالة الـ intent المختار من القائمة لمنع تكراره
            const idx = ordered.findIndex(i => String(i._id) === String(chosen._id));
            if (idx >= 0) ordered.splice(idx, 1);
          }
        }
      }
    }

    // --- TRX native (اختياري: إن كنت تعرض TRX في wallet.js) ---
    const trxIntents = await DepositIntent.find({
      asset_symbol: { $in: SYMBOL_ALIASES.TRX },
      network_name: { $in: ['Tron', 'TRON', 'TRX', 'TRX Native'] },
      $or: [
        { status: 'Pending' },
        { status: 'Expired', expires_at: { $gte: new Date(Date.now() - GRACE_HOURS * 60 * 60 * 1000) } }
      ]
    })
    .select('deposit_address asset_symbol expected_amount status user_id spot_wallet_id')
    .lean();

    if (trxIntents.length) {
      const byAddr = new Map();
      for (const it of trxIntents) {
        const arr = byAddr.get(it.deposit_address) || [];
        arr.push(it); byAddr.set(it.deposit_address, arr);
      }

      for (const [addr, intentsForAddrAll] of byAddr.entries()) {
        const ordered = [
          ...intentsForAddrAll.filter(i => i.status === 'Pending'),
          ...intentsForAddrAll.filter(i => i.status === 'Expired'),
        ];

        let rows = [];
        try {
          rows = await fetchTRX_In(addr);
        } catch {
          continue;
        }
        if (!rows?.length) continue;

        for (const tx of rows) {
          const txid = tx.txid;
          const exists = await ProcessedTx.findOne({ tx_hash: txid });
          if (exists) continue;

          if (tx.to !== addr) continue;
          const amount = Number(tx.amountSun || 0) / 1e6;
          const chosen = pickBestIntent(ordered, amount);
          if (!chosen) continue;

          await createDepositFromIntent(chosen, amount, txid);

          const idx = ordered.findIndex(i => String(i._id) === String(chosen._id));
          if (idx >= 0) ordered.splice(idx, 1);
        }
      }
    }
  } catch (e) {
    console.error('TRON tick error', e.message);
  }
}

function startTronWatcher() {
  const interval = Number(process.env.TRON_POLL_MS || process.env.POLL_INTERVAL_MS || 15000);
  setInterval(tick, interval);
  console.log('TRON watcher started, interval =', interval, 'ms');
}

module.exports = { startTronWatcher };
