const bcrypt = require('bcrypt');
const fs = require('fs');
const path = require('path');
const { User, validateUser } = require('../models/user');

const getUser = async (req, res) => {
  try {
    const user = await User.findById(req.user.id)
      .select('-password')
      .populate('referredBy', 'username referralCode');

    if (!user) return res.status(404).json({ message: 'User not found' });

    res.status(200).json(user);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

const updateUser = async (req, res) => {
  try {
    // ✅ **1️⃣ التحقق من صحة البيانات فقط إذا كانت هناك بيانات نصية**
    if (Object.keys(req.body).length > 0) {
      const { error } = validateUser(req.body, { abortEarly: false });
      if (error) return res.status(400).json({ message: error.details[0].message });
    }

    const { username, email, password } = req.body;
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: 'User not found' });

    // ✅ **2️⃣ تحديث اسم المستخدم والبريد الإلكتروني إذا لزم الأمر**
    if (username && username !== user.username) {
      const usernameExists = await User.findOne({ username });
      if (usernameExists) return res.status(400).json({ message: 'Username already taken' });
      user.username = username;
    }

    if (email && email !== user.email) {
      const emailExists = await User.findOne({ email });
      if (emailExists) return res.status(400).json({ message: 'Email already taken' });
      user.email = email;
    }

    // ✅ **3️⃣ تحديث كلمة المرور إذا تم إرسالها**
    if (password) {
      const salt = await bcrypt.genSalt(10);
      user.password = await bcrypt.hash(password, salt);
    }

    // ✅ **4️⃣ تحديث صورة الملف الشخصي**
    if (req.file) {
      // 🛑 **حذف الصورة القديمة إن وجدت**
      if (user.profile_image && user.profile_image !== 'default.jpg') {
        const oldImagePath = path.join(__dirname, '../uploadedProfile', path.basename(user.profile_image));
        if (fs.existsSync(oldImagePath)) {
          fs.unlink(oldImagePath, (err) => { if (err) console.error('Error deleting old image:', err); });
        }
      }

      // 🆕 **حفظ الصورة الجديدة**
      user.profile_image = `/uploadedProfile/${req.file.filename}`;
    }

    await user.save();
    const updatedUser = await User.findById(req.user.id)
      .select('-password')
      .populate('referredBy', 'username referralCode');
    res.status(200).json({ message: 'User updated successfully', user: updatedUser });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

const deleteUser = async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: 'User not found' });

    // ✅ **حذف صورة الملف الشخصي إذا كانت موجودة**
    if (user.profile_image) {
      const oldImagePath = path.resolve(__dirname, '../uploadedProfile', path.basename(user.profile_image));
      if (fs.existsSync(oldImagePath)) {
        fs.unlinkSync(oldImagePath);
      }
    }

    await User.deleteOne({ _id: user._id });

    res.status(200).json({ message: 'User and all associated data deleted successfully' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

module.exports = { getUser, updateUser, deleteUser };