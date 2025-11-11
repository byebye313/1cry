const fs = require('fs');

// Models & Validation
const {
  PromotionVideo,
  validateCreatePromotionVideo,
  validateReviewPromotionVideo,
  validatePatchMetrics,
} = require('../models/PromotionVideo');
const { Notification } = require('../models/Notification');

// Services & Utils
const { canSubmit, getRewardByType } = require('../services/promotionService');
const { creditSpotUSDT, getSpotUSDTBalance } = require('../services/walletService');
const { deleteFileIfExists } = require('../utils/fsx');

/**
 * POST /api/promotions
 * (User) إنشاء طلب مشاركة جديد - يحتاج multipart/form-data مع حقل screenshot
 */
async function createPromotion(req, res) {
  try {
    if (!req.file) {
      return res.status(400).json({ message: 'Screenshot image is required' });
    }

    const { error, value } = validateCreatePromotionVideo(req.body);
    if (error) return res.status(400).json({ message: error.details[0].message });

    // ✅ 1) منع المستخدم من إرسال أكثر من طلب واحد (pending) لنفس النوع
    const existingPending = await PromotionVideo.findOne({
      user_id: req.user._id,
      type: value.type,
      status: 'pending',
    }).lean();

    if (existingPending) {
      return res.status(409).json({
        message:
          'You already have a pending submission for this type. Please wait for the review result before sending another.',
      });
    }

    // ✅ 2) الكولداون يطبّق فقط بعد القبول (كما هو)
    const ok = await canSubmit(req.user._id, value.type);
    if (!ok) {
      return res.status(429).json({
        message:
          'Cooldown active: please wait before submitting another video of this type.',
      });
    }

    const doc = await PromotionVideo.create({
      user_id: req.user._id,
      type: value.type,
      platform: value.platform,
      video_url: value.video_url,
      description_text: value.description_text,
      screenshot_path: req.file.path,
      screenshot_original_name: req.file.originalname,
      status: 'pending',
    });

    return res.status(201).json({ message: 'Submission created', data: doc });
  } catch (e) {
    if (e?.code === 11000 && e?.keyPattern?.normalized_video_url) {
      return res.status(409).json({
        message:
          'Duplicate video URL detected. Each video can be submitted only once.',
      });
    }
    console.error('createPromotion error:', e);
    return res.status(500).json({ message: 'Server error' });
  }
}

/**
 * GET /api/promotions/my?status=&page=&limit=
 * (User) قائمة طلبات المستخدم
 */
async function listMyPromotions(req, res) {
  try {
    const { page = 1, limit = 20, status } = req.query;
    const q = { user_id: req.user._id };
    if (status) q.status = status;

    const docs = await PromotionVideo.find(q)
      .sort({ created_at: -1 })
      .skip((+page - 1) * +limit)
      .limit(+limit);

    return res.json({ data: docs });
  } catch (e) {
    console.error('listMyPromotions error:', e);
    return res.status(500).json({ message: 'Server error' });
  }
}

/**
 * GET /api/promotions/pending?page=&limit=
 * (Support) قائمة المعلّق
 * - تعيد بيانات المستخدم + رصيد USDT الحالي + رابط تنزيل السكرين شوت
 */
async function listPending(req, res) {
  try {
    const { page = 1, limit = 50 } = req.query;

    const docs = await PromotionVideo.find({ status: 'pending' })
      .sort({ created_at: 1 })
      .skip((+page - 1) * +limit)
      .limit(+limit)
      .populate('user_id', 'username email role');

    const enriched = await Promise.all(
      docs.map(async (d) => {
        const userId = d.user_id?._id || d.user_id;
        const bal = await getSpotUSDTBalance(userId);
        return {
          ...d.toObject(),
          user_spot_usdt_balance: bal,
          screenshot_download_endpoint: `/api/promotions/${d._id}/screenshot`,
        };
      })
    );

    return res.json({ data: enriched });
  } catch (e) {
    console.error('listPending error:', e);
    return res.status(500).json({ message: 'Server error' });
  }
}

/**
 * GET /api/promotions/:id/screenshot
 * (Support) تنزيل ملف السكرين شوت
 */
async function downloadScreenshot(req, res) {
  try {
    const { id } = req.params;
    const doc = await PromotionVideo.findById(id);
    if (!doc) return res.status(404).json({ message: 'Not found' });
    if (!doc.screenshot_path || !fs.existsSync(doc.screenshot_path)) {
      return res.status(404).json({ message: 'Screenshot not found' });
    }
    res.download(doc.screenshot_path, doc.screenshot_original_name);
  } catch (e) {
    console.error('downloadScreenshot error:', e);
    return res.status(500).json({ message: 'Server error' });
  }
}

/**
 * POST /api/promotions/:id/review
 * (Support) مراجعة: approve / reject
 * - بدون معاملات (Transactions) لضمان العمل على Mongo Standalone
 * - يصرف المكافأة (إن وُجدت) + إشعار المستخدم + حذف الصورة بعد المراجعة
 */
async function reviewPromotion(req, res) {
  try {
    const { id } = req.params;
    const { error, value } = validateReviewPromotionVideo(req.body);
    if (error) return res.status(400).json({ message: error.details[0].message });

    const doc = await PromotionVideo.findById(id);
    if (!doc) return res.status(404).json({ message: 'Submission not found' });
    if (doc.status !== 'pending') return res.status(409).json({ message: 'Submission already reviewed' });

    doc.status = value.status;
    doc.review_reason = value.review_reason || null;
    doc.reviewed_by = req.user._id;
    doc.reviewed_at = new Date();

    if (value.status === 'approved') {
      const rewardAmount = getRewardByType(doc.type);
      if (rewardAmount > 0) {
        // بدون session (تعمل على Standalone وReplica Set)
        await creditSpotUSDT(doc.user_id, rewardAmount);
        doc.reward_usdt = rewardAmount;
      }
      await Notification.create([{
        user_id: doc.user_id,
        type: 'Promotion',
        title: 'Video Approved',
        message: `Your ${doc.type} video was approved. Reward: ${doc.reward_usdt} USDT added to your Spot wallet.`,
      }]);
    } else if (value.status === 'rejected') {
      await Notification.create([{
        user_id: doc.user_id,
        type: 'Promotion',
        title: 'Video Rejected',
        message: `Your ${doc.type} video was rejected. Reason: ${doc.review_reason || 'Not specified'}.`,
      }]);
    }

    await doc.save();

    // حذف الملف بعد نجاح العملية
    deleteFileIfExists(doc.screenshot_path);

    return res.json({ message: 'Review saved', data: doc });
  } catch (e) {
    console.error('reviewPromotion error:', e);
    return res.status(500).json({ message: 'Server error' });
  }
}

/**
 * PATCH /api/promotions/:id/metrics
 * (Support) تحديث مشاهدات/لايكات (للوحة الشرف لاحقًا)
 */
async function patchMetrics(req, res) {
  try {
    const { id } = req.params;
    const { error, value } = validatePatchMetrics(req.body);
    if (error) return res.status(400).json({ message: error.details[0].message });

    const doc = await PromotionVideo.findByIdAndUpdate(id, { $set: value }, { new: true });
    if (!doc) return res.status(404).json({ message: 'Not found' });

    return res.json({ message: 'Metrics updated', data: doc });
  } catch (e) {
    console.error('patchMetrics error:', e);
    return res.status(500).json({ message: 'Server error' });
  }
}

module.exports = {
  createPromotion,
  listMyPromotions,
  listPending,
  downloadScreenshot,
  reviewPromotion,
  patchMetrics,
};
