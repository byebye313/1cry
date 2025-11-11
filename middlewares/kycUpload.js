// middlewares/kycUpload.js
const fs = require('fs');
const path = require('path');
const multer = require('multer');

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uid = String(req.user?._id || req.user?.id || 'anonymous');
    const dir = path.join(process.cwd(), 'uploads', 'kyc', uid);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: function (req, file, cb) {
    const isFront = file.fieldname === 'front';
    const ext = path.extname(file.originalname || '').toLowerCase() || '.jpg';
    cb(null, `${isFront ? 'front' : 'back'}${ext}`);
  }
});

const fileFilter = (req, file, cb) => {
  const ok = /image\/(jpeg|jpg|png|webp)/.test(file.mimetype);
  cb(ok ? null : new Error('Only image files are allowed'), ok);
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});

module.exports = upload.fields([{ name: 'front', maxCount: 1 }, { name: 'back', maxCount: 1 }]);
