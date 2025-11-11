const path = require('path');
const fs = require('fs');
const multer = require('multer');


const uploadDir = path.join(process.cwd(), 'uploads', 'promotions');
fs.mkdirSync(uploadDir, { recursive: true });


const storage = multer.diskStorage({
destination: (req, file, cb) => cb(null, uploadDir),
filename: (req, file, cb) => {
const ts = Date.now();
const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
cb(null, `${ts}_${safe}`);
},
});


function fileFilter(req, file, cb) {
// basic filter for images
if (!/^image\//.test(file.mimetype)) return cb(new Error('Invalid file type'), false);
cb(null, true);
}


const upload = multer({ storage, fileFilter, limits: { fileSize: 10 * 1024 * 1024 } });


module.exports = { uploadPromotionScreenshot: upload.single('screenshot') };