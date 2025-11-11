const { wallets } = require('../wallet');

function normalizeNetworkName(n) {
  if (!n) return n;
  const s = n.trim().toLowerCase();
  if (s.includes('beb-20')) return 'BEP-20';
  if (s.includes('litcoin')) return 'Litecoin';
  if (s.includes('bitcion cash')) return 'Bitcoin Cash';
  return n;
}
function normalizeAssetName(a) {
  if (!a) return a;
  const s = a.trim().toLowerCase();
  if (s === 'bnb') return 'BnB';
  if (s === 'ripple') return 'Xrp';
  if (s === 'dogecoin') return 'DogeCoin';
  return a;
}
function getPoolCount() {
  return Array.isArray(wallets) ? wallets.length : 0;
}
function findAddressByPool(poolIndex, assetSymbol, networkName) {
  const pool = wallets[poolIndex];
  if (!pool) return null;
  const targetAsset = normalizeAssetName(assetSymbol);
  const targetNet = normalizeNetworkName(networkName);
  for (const coin of pool.Coins || []) {
    if (coin.name?.trim().toLowerCase() === targetAsset.trim().toLowerCase()) {
      for (const net of coin.networks || []) {
        const netName = normalizeNetworkName(net.name);
        if (netName?.trim().toLowerCase() === targetNet.trim().toLowerCase()) {
          return net.address || net.addrss || null;
        }
      }
    }
  }
  return null;
}
module.exports = { getPoolCount, findAddressByPool, normalizeNetworkName, normalizeAssetName };
