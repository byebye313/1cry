const express = require('express');
const router = express.Router();
const auth = require('../middlewares/authMiddleware');
// const requireSupport = require('../middlewares/requireSupport');
const { leaderboard } = require('../controllers/promotionLeaderboardController');


// Leaderboard can be public or gated; here we allow any authenticated user
router.get('/promotions/leaderboard', auth, leaderboard);


module.exports = router;