// Constants for Promote & Earn


const PROMOTION_TYPES = Object.freeze({
DEPOSIT: 'deposit',
WITHDRAWAL: 'withdrawal',
SECURITY: 'security_support',
AI: 'ai_trading',
GENERAL: 'general',
});


// Rewards in USDT per approved video
const PROMOTION_REWARDS = Object.freeze({
[PROMOTION_TYPES.DEPOSIT]: 2,
[PROMOTION_TYPES.WITHDRAWAL]: 2,
[PROMOTION_TYPES.SECURITY]: 2,
[PROMOTION_TYPES.AI]: 3,
[PROMOTION_TYPES.GENERAL]: 1,
});


// Cooldowns in days (applied **ONLY after an APPROVED submission**)
const PROMOTION_COOLDOWN_DAYS = Object.freeze({
[PROMOTION_TYPES.DEPOSIT]: 7,
[PROMOTION_TYPES.WITHDRAWAL]: 7,
[PROMOTION_TYPES.SECURITY]: 7,
[PROMOTION_TYPES.AI]: 7,
[PROMOTION_TYPES.GENERAL]: 1, // daily
});


// Supported platforms (simple, extend later)
const PROMOTION_PLATFORMS = Object.freeze(['youtube', 'instagram', 'tiktok']);


// Leaderboard metrics (future-friendly)
const LEADERBOARD_METRICS = Object.freeze({
APPROVED_COUNT: 'approved_count',
ENGAGEMENT: 'engagement', // weighted likes/views
});


module.exports = {
PROMOTION_TYPES,
PROMOTION_REWARDS,
PROMOTION_COOLDOWN_DAYS,
PROMOTION_PLATFORMS,
LEADERBOARD_METRICS,
};