const axios = require('axios');
const mongoose = require('mongoose');
const { Asset } = require('../models/Asset');
const { SpotWalletBalance } = require('../models/SpotWalletBalance');
const { FuturesWalletBalance } = require('../models/FutureWalletBalance');
const { User } = require('../models/User');

// Fetch Spot USDT-paired assets from Binance Spot API
async function fetchBinanceSpotUSDTAssets() {
  try {
    const response = await axios.get('https://api.binance.com/api/v3/exchangeInfo');
    const pairs = response.data.symbols;
    const spotAssets = new Set();
    spotAssets.add('USDT'); // Include USDT as a base asset
    pairs.forEach((pair) => {
      if (pair.status === 'TRADING' && pair.quoteAsset === 'USDT') {
        spotAssets.add(pair.baseAsset);
      }
    });
    return Array.from(spotAssets);
  } catch (error) {
    console.error('Error fetching Spot assets from Binance:', error);
    throw error;
  }
}

// Fetch Futures USDT-paired assets from Binance Futures API
async function fetchBinanceFuturesUSDTAssets() {
  try {
    const response = await axios.get('https://fapi.binance.com/fapi/v1/exchangeInfo');
    const pairs = response.data.symbols;
    const futuresAssets = new Set();
    futuresAssets.add('USDT'); // Include USDT as a base asset
    pairs.forEach((pair) => {
      if (pair.contractType === 'PERPETUAL' && pair.quoteAsset === 'USDT') {
        futuresAssets.add(pair.baseAsset);
      }
    });
    return Array.from(futuresAssets);
  } catch (error) {
    console.error('Error fetching Futures assets from Binance:', error);
    throw error;
  }
}

async function seedAssetsAndBalances() {
  try {
    await mongoose.connect('mongodb://localhost/trading_platform', {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log('Connected to MongoDB');

    // Clear previous data (optional)
    await Asset.deleteMany({});
    await SpotWalletBalance.deleteMany({});
    await FuturesWalletBalance.deleteMany({});
    console.log('Previous data cleared');

    // Fetch assets from both Spot and Futures
    const spotAssets = await fetchBinanceSpotUSDTAssets();
    const futuresAssets = await fetchBinanceFuturesUSDTAssets();

    // Combine all unique assets and set their properties
    const allAssets = new Set([...spotAssets, ...futuresAssets]);
    const assetsToSeed = Array.from(allAssets).map((symbol) => ({
      symbol,
      name: symbol,
      networks: [], // Left empty for now, to be filled later for deposits/withdrawals
      is_deposit_enabled: true,
      is_spot_enabled: spotAssets.includes(symbol),
      is_future_enabled: futuresAssets.includes(symbol),
    }));

    const savedAssets = await Asset.insertMany(assetsToSeed);
    console.log(`Seeded ${savedAssets.length} assets`);

    // Fetch all users
    const users = await User.find().populate('spot_wallet futures_wallet');
    if (!users.length) {
      console.log('No users found, skipping balance initialization');
      mongoose.connection.close();
      return;
    }

    // Initialize balances for Spot and Futures wallets
    const spotBalances = [];
    const futuresBalances = [];
    const usdtAsset = savedAssets.find((asset) => asset.symbol === 'USDT' && asset.is_future_enabled);

    for (const user of users) {
      // Populate Spot wallet with all spot-enabled assets
      for (const asset of savedAssets) {
        if (asset.is_spot_enabled) {
          spotBalances.push({
            spot_wallet_id: user.spot_wallet._id,
            asset_id: asset._id,
            balance: 0,
          });
        }
      }
      // Populate Futures wallet with USDT only
      if (usdtAsset) {
        futuresBalances.push({
          futures_wallet_id: user.futures_wallet._id,
          asset_id: usdtAsset._id,
          balance: 0,
        });
      }
    }

    await Promise.all([
      SpotWalletBalance.insertMany(spotBalances),
      FuturesWalletBalance.insertMany(futuresBalances),
    ]);
    console.log(`Initialized ${spotBalances.length} Spot balances and ${futuresBalances.length} Futures balances`);

    mongoose.connection.close();
  } catch (error) {
    console.error('Error during seeding:', error);
    mongoose.connection.close();
  }
}

seedAssetsAndBalances();