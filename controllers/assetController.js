const axios = require('axios');
const { Asset } = require('../models/Asset');
const { TradingPair } = require('../models/TradingPair');
const { getOrderBook: getCachedOrderBook } = require('./../services/binanceFuturesService');

// Utility function for retrying API requests
const retryRequest = async (fn, maxRetries = 3, delay = 1000) => {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt === maxRetries) throw error;
      console.log(`Retry attempt ${attempt}/${maxRetries} failed. Retrying in ${delay}ms...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay *= 2; // Exponential backoff
    }
  }
};

const fetchAndStoreSpotAssets = async (req, res) => {
  try {
    const response = await retryRequest(() =>
      axios.get('https://api.binance.com/api/v3/exchangeInfo', { timeout: 30000 })
    );
    const symbols = response.data.symbols;

    const spotAssets = new Set();
    symbols.forEach((symbol) => {
      if (symbol.quoteAsset === 'USDT') {
        spotAssets.add(symbol.baseAsset);
      }
      if (symbol.baseAsset === 'USDT') {
        spotAssets.add(symbol.quoteAsset);
      }
    });

    const existingAssets = await Asset.find({}, 'symbol');
    const existingSymbols = new Set(existingAssets.map((asset) => asset.symbol));

    const newAssets = Array.from(spotAssets)
      .filter((symbol) => !existingSymbols.has(symbol))
      .map((symbol) => ({
        symbol,
        name: symbol,
      }));

    if (newAssets.length > 0) {
      await Asset.insertMany(newAssets);
    }

    const allAssets = await Asset.find();
    const assetMap = new Map(allAssets.map((asset) => [asset.symbol, asset._id]));

    const existingPairs = await TradingPair.find({}, 'symbol');
    const existingPairSymbols = new Set(existingPairs.map((pair) => pair.symbol));

    const newPairs = Array.from(spotAssets)
      .filter((symbol) => symbol !== 'USDT')
      .filter((symbol) => !existingPairSymbols.has(`${symbol}USDT`))
      .map((symbol) => {
        const baseAssetId = assetMap.get(symbol);
        const quoteAssetId = assetMap.get('USDT');
        if (!baseAssetId || !quoteAssetId) {
          throw new Error(`Asset not found for symbol: ${symbol} or USDT`);
        }
        return {
          symbol: `${symbol}USDT`,
          base_asset_id: baseAssetId,
          quote_asset_id: quoteAssetId,
        };
      });

    if (newPairs.length > 0) {
      await TradingPair.insertMany(newPairs);
    }

    return res.status(200).json(allAssets);
  } catch (error) {
    console.error('Error fetching spot assets:', error.message);
    return res.status(500).json({ message: 'Internal server error', error: error.message });
  }
};

const getAssets = async (req, res) => {
  try {
    const assets = await Asset.find();
    return res.status(200).json(assets);
  } catch (error) {
    console.error('Error fetching assets from database:', error.message);
    return res.status(500).json({ message: 'Internal server error', error: error.message });
  }
};

const getSpotTradingPairs = async (req, res) => {
  try {
    const tradingPairs = await TradingPair.find()
      .populate('base_asset_id', 'symbol name')
      .populate('quote_asset_id', 'symbol name');
    return res.status(200).json(tradingPairs);
  } catch (error) {
    console.error('Error fetching spot trading pairs:', error.message);
    return res.status(500).json({ message: 'Internal server error', error: error.message });
  }
};

const getOrderBook = async (req, res) => {
  try {
    const { symbol } = req.params;
    if (!symbol) {
      return res.status(400).json({ message: 'Trading pair symbol is required' });
    }

    const response = await retryRequest(() =>
      axios.get('https://api.binance.com/api/v3/depth', {
        params: {
          symbol: symbol.toUpperCase(),
          limit: 10,
        },
        timeout: 15000,
      })
    );

    const { bids, asks, lastUpdateId } = response.data;

    const formattedBids = bids.map(([price, amount]) => ({
      price: parseFloat(price),
      amount: parseFloat(amount),
    }));

    const formattedAsks = asks.map(([price, amount]) => ({
      price: parseFloat(price),
      amount: parseFloat(amount),
    }));

    const snapshotResponse = await retryRequest(() =>
      axios.get('https://api.binance.com/api/v3/ticker/price', {
        params: {
          symbol: symbol.toUpperCase(),
        },
        timeout: 15000,
      })
    );

    const currentPrice = parseFloat(snapshotResponse.data.price);

    return res.status(200).json({
      bids: formattedBids,
      asks: formattedAsks,
      currentPrice,
      lastUpdateId,
    });
  } catch (error) {
    console.error('Error fetching spot order book:', error.message);
    if (error.response) {
      console.error('Binance API Response Error:', error.response.status, error.response.data);
      return res.status(500).json({
        message: 'Error fetching order book from Binance API',
        details: error.response.data,
      });
    } else if (error.request) {
      console.error('No response received from Binance API:', error.request);
      return res.status(500).json({
        message: 'No response received from Binance API',
      });
    } else {
      console.error('Error setting up the Binance API request:', error.message);
      return res.status(500).json({ message: 'Internal server error', error: error.message });
    }
  }
};

const getFuturesOrderBook = async (req, res) => {
  try {
    const { symbol } = req.params;
    if (!symbol) {
      return res.status(400).json({ message: 'Trading pair symbol is required' });
    }

    // Try fetching from Binance Futures API
    let response;
    try {
      response = await retryRequest(() =>
        axios.get('https://fapi.binance.com/fapi/v1/depth', {
          params: {
            symbol: symbol.toUpperCase(),
            limit: 10,
          },
          timeout: 20000,
        })
      );
    } catch (binanceError) {
      console.warn(`Failed to fetch from Binance Futures API for ${symbol}: ${binanceError.message}`);
      // Fallback to cached orderBookMap
      const cachedOrderBook = getCachedOrderBook(symbol.toUpperCase());
      if (cachedOrderBook && cachedOrderBook.bids.length > 0 && cachedOrderBook.asks.length > 0) {
        console.log(`Returning cached order book for ${symbol}`);
        return res.status(200).json({
          bids: cachedOrderBook.bids,
          asks: cachedOrderBook.asks,
          currentPrice: cachedOrderBook.bids[0]?.[0] || null,
          timestamp: cachedOrderBook.timestamp,
        });
      } else {
        throw new Error('No cached order book available');
      }
    }

    const { bids, asks, lastUpdateId } = response.data;

    const formattedBids = bids.map(([price, amount]) => [
      parseFloat(price),
      parseFloat(amount),
    ]);

    const formattedAsks = asks.map(([price, amount]) => [
      parseFloat(price),
      parseFloat(amount),
    ]);

    const snapshotResponse = await retryRequest(() =>
      axios.get('https://fapi.binance.com/fapi/v1/ticker/price', {
        params: {
          symbol: symbol.toUpperCase(),
        },
        timeout: 20000,
      })
    );

    const currentPrice = parseFloat(snapshotResponse.data.price);

    return res.status(200).json({
      bids: formattedBids,
      asks: formattedAsks,
      currentPrice,
      timestamp: Date.now(),
    });
  } catch (error) {
    console.error('Error fetching futures order book:', error.message);
    if (error.response) {
      console.error('Binance Futures API Response Error:', error.response.status, error.response.data);
      return res.status(500).json({
        message: 'Error fetching futures order book from Binance API',
        details: error.response.data,
      });
    } else if (error.request) {
      console.error('No response received from Binance Futures API:', error.request);
      return res.status(500).json({
        message: 'No response received from Binance Futures API',
      });
    } else {
      console.error('Error setting up the Binance Futures API request:', error.message);
      return res.status(500).json({ message: 'Internal server error', error: error.message });
    }
  }
};

module.exports = { fetchAndStoreSpotAssets, getAssets, getSpotTradingPairs, getOrderBook, getFuturesOrderBook };