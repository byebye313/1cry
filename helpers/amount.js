function addFingerprint(baseAmount, decimals = 6) {
  const scale = 10 ** decimals;
  const base = Math.round(Number(baseAmount || 0) * scale);
  const fp = Math.floor(100 + Math.random() * 900);
  const sum = base + fp;
  return (sum / scale).toFixed(decimals);
}
module.exports = { addFingerprint };
