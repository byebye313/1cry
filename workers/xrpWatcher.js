const xrpl = require('xrpl');
const DepositIntent = require('../models/DepositIntent');
const { Deposit } = require('../models/Deposit');
const ProcessedTx = require('../models/ProcessedTx');
const {Asset} = require('../models/Asset');

async function matchCreateDeposit({ address, destTag, amount, tx_hash }) {
  const exists = await ProcessedTx.findOne({ tx_hash });
  if (exists) return false;

  const intent = await DepositIntent.findOne({
    deposit_address: address,
    network_name: 'Ripple',
    asset_symbol: 'XRP',
    memo_tag: String(destTag),
    status: 'Pending'
  }).sort({ createdAt: 1 });
  if (!intent) return false;

  if (String(Number(intent.expected_amount)) !== String(Number(amount))) return false;

  intent.status = 'Matched';
  intent.matched_tx_hash = tx_hash;
  intent.matched_at = new Date();
  await intent.save();

  const asset = await Asset.findOne({ symbol: 'XRP' });
  await Deposit.create({
    user_id: intent.user_id,
    spot_wallet_id: intent.spot_wallet_id,
    asset_id: asset?._id,
    amount: Number(amount),
    status: 'Pending'
  });

  await ProcessedTx.create({ tx_hash, address, network_key: 'xrp' });
  return true;
}

async function tick() {
  let client;
  try {
    client = new xrpl.Client(process.env.XRP_RPC_HTTP || 'wss://s1.ripple.com/');
    await client.connect();

    const intents = await DepositIntent.find({ status: 'Pending', network_name: 'Ripple' })
      .select('deposit_address memo_tag expected_amount');
    const grouped = {};
    for (const it of intents) {
      if (!grouped[it.deposit_address]) grouped[it.deposit_address] = [];
      grouped[it.deposit_address].push(it);
    }

    for (const [address, items] of Object.entries(grouped)) {
      const resp = await client.request({
        command: 'account_tx', account: address,
        ledger_index_min: -1, ledger_index_max: -1, limit: 50, forward: false
      });
      const txs = resp.result.transactions || [];
      for (const t of txs) {
        const tx = t.tx || {};
        if (tx.TransactionType !== 'Payment') continue;
        if (tx.Destination !== address) continue;

        const tag = tx.DestinationTag;
        if (tag == null) continue;
        const amount = Number(tx.Amount) / (10 ** 6);
        const hash = tx.hash || t.hash;
        await matchCreateDeposit({ address, destTag: tag, amount, tx_hash: hash });
      }
    }
  } catch (e) {
    console.error('XRP tick error', e.message);
  } finally {
    if (client) try { await client.disconnect(); } catch {}
  }
}

function startXrpWatcher() {
  const interval = Number(process.env.POLL_INTERVAL_MS || 20000);
  setInterval(tick, interval);
  console.log('XRP watcher started');
}

module.exports = { startXrpWatcher };
