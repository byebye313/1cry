// services/chainMaps.js
module.exports = {
  confirmations: {
    evm_eth: 12,
    evm_bsc: 15,
    tron: 20,
    btc: 2,
    ltc: 6,
    bch: 2,
    dash: 2,
    doge: 2,
    xrp: 5
  },
  // Decimals افتراضية عند عدم توفر دقة من العقد/المصدر
  decimalsByAsset: {
    BTC: 8, LTC: 8, BCH: 8, DASH: 8, DOGE: 8,
    ETH: 18, BNB: 18, TRX: 6, XRP: 6,
    USDT: 6, USDC: 6, MATIC: 18, GALA: 8, MANA: 18, SUSHI: 18,
    // يمكن تعديلها من .env أو من DB لاحقاً
  } 
};
