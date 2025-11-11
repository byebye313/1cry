const { referralController } = require('../controllers/referralController');
const express = require('express');
const router = express.Router();

router.post('/', referralController.createReferral);
router.get('/:referrer_id', referralController.getReferralStatus);
router.post('/collect-prize', referralController.collectReferralPrize);
router.get('/:referrer_id/stats', referralController.getReferralStats);
router.get('/:referrer_id/reward-history', referralController.getRewardHistory);

module.exports = router;