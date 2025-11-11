// routes/kycRoutes.js
const express = require('express');
const router = express.Router();
const auth = require('../middlewares/authMiddleware');
const upload = require('../middlewares/kycUpload');
const kyc = require('../controllers/kycController');

// user
router.post('/', auth, upload, kyc.submit);
router.get('/mine', auth, kyc.mine);

// support
router.get('/pending', auth, kyc.pending);
router.patch('/:id/approve', auth, kyc.approve);
router.patch('/:id/reject', auth, kyc.reject);

module.exports = router;
