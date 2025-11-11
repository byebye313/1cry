// src/utils/futuresCalculation.js

/**
 * وظائف مساعدة لحسابات تداول العقود الآجلة.
 * @module futuresCalculation
 */

/**
 * يحسب سعر التصفية (Liquidation Price) لصفقة عقد آجل.
 * @param {number} openPrice - سعر فتح المركز.
 * @param {number} leverage - الرافعة المالية المستخدمة (مثلاً 10).
 * @param {string} position - النوع ('Long' أو 'Short').
 * @param {string} marginType - النوع ('Isolated' أو 'Cross').
 * @param {number} initialMargin - الهامش الأولي.
 * @param {number} [walletBalance=0] - رصيد المحفظة الكامل (لـ Cross فقط).
 * @param {number} [unrealizedPnlOther=0] - PNL غير محقق للمراكز الأخرى (لـ Cross).
 * @param {number} [maintenanceMarginOther=0] - هامش الصيانة للمراكز الأخرى (لـ Cross).
 * @returns {number|null} سعر التصفية أو null إذا غير صالح.
 */
function calculateLiquidationPrice(openPrice, leverage, position, marginType, initialMargin, walletBalance = 0, unrealizedPnlOther = 0, maintenanceMarginOther = 0) {
  if (!openPrice || !leverage || !position || !initialMargin) {
    return null;
  }

  const maintenanceMarginRate = 0.004; // 0.4% افتراضي، يمكن جعله ديناميكي بناءً على tier
  const initialMarginRate = 1 / leverage;

  let liquidationPrice;

  if (marginType === 'Isolated') {
    // صيغة مبسطة لـ Isolated (تقريب Binance)
    if (position === 'Long') {
      liquidationPrice = openPrice * (1 - initialMarginRate + maintenanceMarginRate);
      if (liquidationPrice < 0) liquidationPrice = 0;
    } else if (position === 'Short') {
      liquidationPrice = openPrice * (1 + initialMarginRate - maintenanceMarginRate);
    }
  } else if (marginType === 'Cross') {
    // صيغة Binance لـ Cross (من ، تحتاج بيانات إضافية)
    const maintenanceMarginCurrent = initialMargin * maintenanceMarginRate; // تقريب
    const unrealizedPnlCurrent = 0; // افتراضي، يمكن حسابه إذا لزم
    if (position === 'Long') {
      liquidationPrice = (walletBalance - maintenanceMarginOther + unrealizedPnlOther + maintenanceMarginCurrent) /
        (1 + maintenanceMarginRate - unrealizedPnlCurrent / openPrice); // مبسط
    } else if (position === 'Short') {
      liquidationPrice = (walletBalance - maintenanceMarginOther + unrealizedPnlOther + maintenanceMarginCurrent) /
        (1 - maintenanceMarginRate + unrealizedPnlCurrent / openPrice);
    }
  } else {
    return null;
  }

  return liquidationPrice > 0 ? liquidationPrice : null;
}

/**
 * يحسب الربح والخسارة غير المحققة (Unrealized PnL).
 * @param {number} openPrice - سعر فتح.
 * @param {number} currentPrice - السعر الحالي.
 * @param {number} amount - الكمية.
 * @param {number} leverage - الرافعة (غير مستخدمة مباشرة في PnL).
 * @param {string} position - النوع ('Long' أو 'Short').
 * @returns {number} PnL.
 */
function calculatePnL(openPrice, currentPrice, amount, leverage, position) {
  if (!openPrice || !currentPrice || !amount || !position) {
    return 0;
  }
  
  let pnl;
  if (position === 'Long') {
    pnl = (currentPrice - openPrice) * amount;
  } else if (position === 'Short') {
    pnl = (openPrice - currentPrice) * amount;
  } else {
    return 0;
  }
  return pnl;
}

module.exports = {
  calculateLiquidationPrice,
  calculatePnL,
};