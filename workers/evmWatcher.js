const { ethers } = require('ethers');
const DepositIntent = require('../models/DepositIntent');
const { Deposit } = require('../models/Deposit');
const ProcessedTx = require('../models/ProcessedTx');
const {Asset} = require('../models/Asset');
const {SpotWalletBalance} = require('../models/SpotWalletBalance');
const tokenContracts = require('../services/tokenContracts');

function providers() {
  const eth = process.env.ETH_RPC_HTTP ? new ethers.JsonRpcProvider(process.env.ETH_RPC_HTTP) : null;
  const bsc = process.env.BSC_RPC_HTTP ? new ethers.JsonRpcProvider(process.env.BSC_RPC_HTTP) : null;
  return { eth, bsc };
}

async function collectAddresses(network_name) {
  return DepositIntent.find({ status: 'Pending', network_name }).distinct('deposit_address');
}

async function matchCreateDeposit({ symbol, network_name, address, amount, tx_hash, blockNumber }) {
  const exists = await ProcessedTx.findOne({ tx_hash });
  if (exists) return false;

  const intent = await DepositIntent.findOne({
    deposit_address: address, asset_symbol: symbol, network_name, status: 'Pending'
  }).sort({ createdAt: 1 });
  if (!intent) return false;

  if (String(Number(intent.expected_amount)) !== String(Number(amount))) return false;

  intent.status = 'Matched';
  intent.matched_tx_hash = tx_hash;
  intent.matched_block_number = blockNumber || 0;
  intent.matched_at = new Date();
  await intent.save();

  const asset = await Asset.findOne({ symbol });
  await Deposit.create({
    user_id: intent.user_id,
    spot_wallet_id: intent.spot_wallet_id,
    asset_id: asset?._id,
    amount: Number(amount),
    status: 'Pending'
  });

  await ProcessedTx.create({ tx_hash, address, network_key: network_name.toLowerCase().includes('bep') ? 'evm_bsc' : 'evm_eth' });
  return true;
}

async function scanErc20(provider, chainKey, networkName) {
  if (!provider) return;
  const contracts = tokenContracts[chainKey] || {};
  const addresses = (await collectAddresses(networkName)).map(a => a.toLowerCase());
  if (!addresses.length) return;

  const iface = new ethers.Interface(["event Transfer(address indexed from, address indexed to, uint256 value)"]);
  const topic = ethers.id("Transfer(address,address,uint256)");
  const currentBlock = await provider.getBlockNumber();
  const fromBlock = Math.max(currentBlock - 1500, 0);

  for (const [symbol, info] of Object.entries(contracts)) {
    if (!info.address) continue;
    const logs = await provider.getLogs({ address: info.address, topics: [topic], fromBlock, toBlock: currentBlock });
    for (const log of logs) {
      const parsed = iface.parseLog(log);
      const to = String(parsed.args[1]).toLowerCase();
      const target = addresses.find(a => a === to);
      if (!target) continue;

      const amount = Number(parsed.args[2]) / (10 ** (info.decimals || 18));
      await matchCreateDeposit({
        symbol, network_name: networkName, address: target, amount,
        tx_hash: log.transactionHash, blockNumber: log.blockNumber
      });
    }
  }
}

async function scanNative(provider, networkName, nativeSymbol) {
  if (!provider) return;
  const addresses = (await collectAddresses(networkName)).map(a => a.toLowerCase());
  if (!addresses.length) return;

  const currentBlock = await provider.getBlockNumber();
  const fromBlock = Math.max(currentBlock - 300, 0);
  for (let b = fromBlock; b <= currentBlock; b++) {
    const block = await provider.getBlockWithTransactions(b);
    for (const tx of block.transactions) {
      if (!tx.to) continue;
      const toLower = tx.to.toLowerCase();
      const target = addresses.find(a => a === toLower);
      if (!target) continue;
      const amount = Number(ethers.formatEther(tx.value || 0n));
      await matchCreateDeposit({
        symbol: nativeSymbol, network_name: networkName, address: target, amount,
        tx_hash: tx.hash, blockNumber: b
      });
    }
  }
}

async function tick() {
  try {
    const { eth, bsc } = providers();
    await scanErc20(eth, 'eth', 'Ethereum ERC-20'); // ERC-20
    await scanNative(eth, 'ERC-20', 'ETH');        // ETH native (اسم الشبكة عندك هكذا)
    await scanErc20(bsc, 'bsc', 'BEP-20');         // BEP-20
    await scanNative(bsc, 'BEP-20', 'BNB');        // BNB native
  } catch (e) {
    console.error('EVM tick error', e.message);
  }
}

function startEvmWatcher() {
  const interval = Number(process.env.POLL_INTERVAL_MS || 15000);
  setInterval(tick, interval);
  console.log('EVM watcher started');
}

module.exports = { startEvmWatcher };
