const axios = require('axios');
const TronWeb = require('tronweb');
const { ethers } = require('ethers');

// إعدادات الشبكات (يمكنك تخصيصها لاحقًا)
const tronWeb = new TronWeb({
  fullHost: 'https://api.trongrid.io', // Tron Mainnet
  // أضف API Key إذا لزم الأمر
});
const ethProvider = new ethers.providers.JsonRpcProvider('https://mainnet.infura.io/v3/YOUR_INFURA_KEY'); // استبدل بـ Infura Key

async function verifyTransaction(networkName, txHash, depositAddress, amount, assetSymbol) {
  try {
    if (networkName.includes('Tron TRC-20')) {
      const tx = await tronWeb.trx.getTransaction(txHash);
      if (!tx || !tx.ret || tx.ret[0].contractRet !== 'SUCCESS') {
        return { verified: false, reason: 'Transaction failed or not found' };
      }

      const transfer = tx.raw_data.contract[0].parameter.value;
      const toAddress = tronWeb.address.fromHex(transfer.to_address);
      const txAmount = transfer.amount / 10 ** 6; // افتراض 6 منازل عشرية لـ USDT

      if (toAddress !== depositAddress || txAmount !== amount || assetSymbol !== 'USDT') {
        return { verified: false, reason: 'Invalid recipient, amount, or asset' };
      }
      return { verified: true };
    } else if (networkName.includes('Ethereum ERC-20') || networkName.includes('BEP-20')) {
      const tx = await ethProvider.getTransaction(txHash);
      if (!tx) return { verified: false, reason: 'Transaction not found' };

      const receipt = await ethProvider.getTransactionReceipt(txHash);
      if (!receipt || receipt.status !== 1) {
        return { verified: false, reason: 'Transaction failed' };
      }

      // افتراض أن العملة ERC-20 (مثل USDT)
      const usdtContractAddress = '0xdAC17F958D2ee523a2206206994597C13D831ec7'; // USDT على Ethereum
      if (tx.to.toLowerCase() !== usdtContractAddress.toLowerCase()) {
        return { verified: false, reason: 'Not a valid token transfer' };
      }

      // تحليل البيانات (Data) للتحقق من المبلغ والعنوان (يتطلب ABI للعقد)
      // هنا مثال مبسط
      const decoded = ethers.utils.defaultAbiCoder.decode(
        ['address', 'uint256'],
        ethers.utils.hexDataSlice(tx.data, 4)
      );
      const toAddress = decoded[0];
      const txAmount = ethers.utils.formatUnits(decoded[1], 6); // 6 منازل لـ USDT

      if (toAddress.toLowerCase() !== depositAddress.toLowerCase() || parseFloat(txAmount) !== amount) {
        return { verified: false, reason: 'Invalid recipient or amount' };
      }
      return { verified: true };
    } else if (networkName === 'Bitcoin') {
      const response = await axios.get(`https://api.blockcypher.com/v1/btc/main/txs/${txHash}`);
      const tx = response.data;

      const totalOutput = tx.outputs.reduce((sum, output) => sum + output.value, 0) / 10 ** 8; // تحويل Satoshi إلى BTC
      const toAddress = tx.outputs.find((o) => o.addresses.includes(depositAddress));

      if (!toAddress || totalOutput !== amount) {
        return { verified: false, reason: 'Invalid recipient or amount' };
      }
      return { verified: true };
    } else {
      return { verified: false, reason: 'Unsupported network' };
    }
  } catch (error) {
    console.error(`Error verifying transaction ${txHash}:`, error);
    return { verified: false, reason: 'Verification error' };
  }
}

module.exports = { verifyTransaction };