// seedAssetsAndTradingPairs.js
require('dotenv').config();
const axios = require('axios');
const mongoose = require('mongoose');

// نماذجك الحالية
const { Asset } = require('../models/Asset');           // تأكد من المسار الصحيح
const { TradingPair } = require('../models/TradingPair');

const MONGODB_URI = 'mongodb+srv://hass:Youzghadli%40123@cluster0.fhefpqk.mongodb.net/1cryptox'; // ضع في .env

async function fetchSpotUSDTBaseAssets() {
  const { data } = await axios.get('https://api.binance.com/api/v3/exchangeInfo');
  const set = new Set(['USDT']);
  for (const s of data.symbols) {
    if (s.status === 'TRADING' && s.quoteAsset === 'USDT') {
      set.add(s.baseAsset);
    }
  }
  return Array.from(set);
}

async function fetchFuturesUSDTBaseAssets() {
  const { data } = await axios.get('https://fapi.binance.com/fapi/v1/exchangeInfo');
  const set = new Set(['USDT']);
  for (const s of data.symbols) {
    if (s.contractType === 'PERPETUAL' && s.quoteAsset === 'USDT') {
      set.add(s.baseAsset);
    }
  }
  return Array.from(set);
}

async function main() {
  await mongoose.connect(MONGODB_URI, {});

  // 1) اجلب أصول Spot/Futures (USDT أزواج)
  const [spotAssets, futAssets] = await Promise.all([
    fetchSpotUSDTBaseAssets(),
    fetchFuturesUSDTBaseAssets(),
  ]);

  // 2) كوّن مجموعة موحّدة للأصول
  const allAssets = Array.from(new Set([...spotAssets, ...futAssets]));

  // 3) Upsert للأصول (متوافق مع Asset.js الحالي)
  //    Asset: { symbol (unique), name, is_deposit_enabled }
  const assetBulk = allAssets.map((sym) => ({
    updateOne: {
      filter: { symbol: sym },
      update: {
        $setOnInsert: {
          symbol: sym,
          name: sym,
          is_deposit_enabled: true,
          created_at: new Date(),
        },
        $set: { updated_at: new Date() },
      },
      upsert: true,
    },
  }));
  if (assetBulk.length) {
    await Asset.bulkWrite(assetBulk);
  }

  // 4) ابنِ خريطة symbol -> _id
  const assetsDocs = await Asset.find({ symbol: { $in: allAssets } }).select('_id symbol');
  const idBySymbol = new Map(assetsDocs.map((a) => [a.symbol, a._id]));

  // تأكد من وجود USDT
  if (!idBySymbol.has('USDT')) {
    throw new Error('USDT asset is missing after upsert. Check Asset model/seed.');
  }

  // 5) كوّن قائمة الأزواج BASE/USDT (Spot + Futures)
  //    إن رغبت في التمييز، يمكنك إضافة حقل "type" لاحقًا في TradingPair schema،
  //    لكن مخططك الحالي لا يحتويه؛ سنُنشئ الأزواج بنفس البنية الحالية.
  const baseAssetsForPairs = new Set([
    ...spotAssets.filter((s) => s !== 'USDT'),
    ...futAssets.filter((s) => s !== 'USDT'),
  ]);

  const quoteId = idBySymbol.get('USDT');
  const pairBulk = [];
  for (const base of baseAssetsForPairs) {
    const baseId = idBySymbol.get(base);
    if (!baseId) continue;

    const pairSymbol = `${base}USDT`;
    pairBulk.push({
      updateOne: {
        filter: { symbol: pairSymbol },
        update: {
          $setOnInsert: {
            base_asset_id: baseId,
            quote_asset_id: quoteId,
            symbol: pairSymbol,
            created_at: new Date(),
          },
          $set: { updated_at: new Date() },
        },
        upsert: true,
      },
    });
  }

  if (pairBulk.length) {
    await TradingPair.bulkWrite(pairBulk);
  }

  console.log(`Upserted assets: ${assetBulk.length}, trading pairs: ${pairBulk.length}`);
  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error(e);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
