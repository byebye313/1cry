const express = require('express');
const fs = require('fs');
const path = require('path');

const router = express.Router();

// تحديد مسار مجلد الصور
const imagesDirectory = path.join(__dirname, '../ProfileImages');

router.get('/', (req, res) => {
  fs.readdir(imagesDirectory, (err, files) => {
    if (err) {
      return res.status(500).json({ message: 'Error reading images directory' });
    }

    // تصفية الملفات للتأكد من أنها صور فقط
    const imageFiles = files.filter(file => /\.(jpg|jpeg|png|gif)$/i.test(file));

    // إرجاع قائمة بأسماء الصور
    res.json(imageFiles);
  });
});

module.exports = router;
