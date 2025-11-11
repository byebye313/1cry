const mongoose = require('mongoose');
const { PromotionVideo } = require('../models/PromotionVideo');
const { LEADERBOARD_METRICS } = require('../constants/promotion');


async function leaderboard(req, res) {
try {
const { metric = LEADERBOARD_METRICS.APPROVED_COUNT, limit = 20 } = req.query;


if (metric === LEADERBOARD_METRICS.APPROVED_COUNT) {
const rows = await PromotionVideo.aggregate([
{ $match: { status: 'approved' } },
{ $group: { _id: '$user_id', approved_count: { $sum: 1 } } },
{ $sort: { approved_count: -1 } },
{ $limit: Number(limit) },
]);
return res.json({ data: rows });
}


if (metric === LEADERBOARD_METRICS.ENGAGEMENT) {
const rows = await PromotionVideo.aggregate([
{ $match: { status: 'approved' } },
{ $addFields: { engagement: { $add: ['$likes_count', { $divide: ['$views_count', 100] }] } } },
{ $group: { _id: '$user_id', engagement: { $sum: '$engagement' } } },
{ $sort: { engagement: -1 } },
{ $limit: Number(limit) },
]);
return res.json({ data: rows });
}


return res.status(400).json({ message: 'Unsupported metric' });
} catch (e) {
console.error('leaderboard error:', e);
return res.status(500).json({ message: 'Server error' });
}
}


module.exports = { leaderboard };