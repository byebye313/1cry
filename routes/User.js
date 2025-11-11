const express = require('express');
const router = express.Router();
const authMiddleware = require('../middlewares/authMiddleware');
const userController = require('../controllers/userController');
const { getUser } = require('../controllers/userController');
const multer = require('multer');
const path = require('path');

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(__dirname, '../uploadedProfile'));
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  },
});
const upload = multer({ storage });

// مسارات محمية
router.get('/me', authMiddleware, getUser);
router.put('/me', authMiddleware, upload.single('profile_image'), userController.updateUser);
router.delete('/me', authMiddleware, userController.deleteUser);

module.exports = router;
