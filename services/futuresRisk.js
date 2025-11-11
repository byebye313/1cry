// services/futuresRisk.js
// Simple risk model (tiered MMR can be added later)
function getRiskParams(notional) {
  // Example: flat MMR for now; you can implement tiers by notional
  return { mmr: 0.005, mmadd: 0 }; // 0.5% maintenance margin
}

// BaseEquity:
// - Isolated: initial margin for the position only
// - Cross: initial margin + free cross balance (passed in)
function computeLiquidationPrice({
  side,              // "Long" | "Short"
  qty,               // > 0
  entryPrice,        // E
  baseEquity,        // isolated IM, or isolated IM + free cross balance
  notionalHint,      // E * qty or currentMark * qty
  feesBuffer = 0,    // small buffer to cover closing fees/slippage
}) {
  const q = Math.abs(qty);
  const { mmr, mmadd } = getRiskParams(notionalHint);

  if (side === 'Long') {
    const numerator = (entryPrice * q) - baseEquity + mmadd + feesBuffer;
    const denom = (1 - mmr) * q;
    return numerator / denom;
  } else {
    const numerator = baseEquity + (entryPrice * q) - mmadd - feesBuffer;
    const denom = (1 + mmr) * q;
    return numerator / denom;
  }
}

function computePnl({ side, entryPrice, exitPrice, qty }) {
  const q = Math.abs(qty);
  const diff = (side === 'Long') ? (exitPrice - entryPrice) : (entryPrice - exitPrice);
  return diff * q;
}

module.exports = { computeLiquidationPrice, computePnl };
