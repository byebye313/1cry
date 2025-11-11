const { PromotionVideo } = require('../models/PromotionVideo');
const { PROMOTION_COOLDOWN_DAYS } = require('../constants/promotion');


function addDays(date, days) {
const d = new Date(date);
d.setDate(d.getDate() + days);
return d;
}


// Cooldown applies ONLY after the last APPROVED submission for the same type.
async function canSubmit(userId, type) {
const lastApproved = await PromotionVideo.findOne({ user_id: userId, type, status: 'approved' })
.sort({ created_at: -1 })
.lean();


const cooldownDays = PROMOTION_COOLDOWN_DAYS[type];
if (!cooldownDays) return true;
if (!lastApproved) return true;


const nextAllowed = addDays(lastApproved.created_at, cooldownDays);
return new Date() >= nextAllowed;
}


function getRewardByType(type) {
const table = {
deposit: 2,
withdrawal: 2,
security_support: 2,
ai_trading: 3,
general: 1,
};
return table[type] || 0;
}


module.exports = { canSubmit, getRewardByType };