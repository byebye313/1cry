// services/tokenContracts.js
module.exports = {
  eth: { // شبكة Ethereum
    // symbol: { address, decimals }
    USDT: { address: process.env.ERC20_USDT || '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6 },
    USDC: { address: process.env.ERC20_USDC || '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6 },
    MANA: { address: process.env.ERC20_MANA || '0x0f5D2fB29fb7d3CFeE444a200298f468908cC942', decimals: 18 },
    SUSHI:{ address: process.env.ERC20_SUSHI|| '0x6B3595068778DD592e39A122f4f5a5CF09C90fE2', decimals: 18 },
    GALA: { address: process.env.ERC20_GALA || '0x15D4c048F83bd7e37d49ea4C83a07267Ec4203dA', decimals: 8 },
    MATIC:{ address: process.env.ERC20_MATIC|| '0x7d1afa7b718fb893db30a3abc0cfc608aacfebb0', decimals: 18 }, // MATIC ERC20 على ETH
    BNB:  { address: process.env.ERC20_BNB  || '', decimals: 18 } // إن كنت تستخدم BNB كتوكن على ETH (نادر)
  },
  bsc: { // شبكة Binance Smart Chain
    USDT: { address: process.env.BEP20_USDT || '0x55d398326f99059fF775485246999027B3197955', decimals: 18 },
    USDC: { address: process.env.BEP20_USDC || '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', decimals: 18 },
    SUSHI:{ address: process.env.BEP20_SUSHI|| '0x947950BcC74888a40Ffa2593C5798F11Fc9124C4', decimals: 18 },
    MANA: { address: process.env.BEP20_MANA || '', decimals: 18 }, // ضع العقد الصحيح إن أردت دعمها على BSC
    MATIC:{ address: process.env.BEP20_MATIC|| '', decimals: 18 },
    TRX:  { address: process.env.BEP20_TRX  || '', decimals: 18 }, // إن أردت دعم TRX كـBEP20
    BNB:  { address: '', decimals: 18 } // BNB native (ليس توكن)، يُرصد عبر native scan
  }
};
