// controllers/kycController.js
const path = require('path');
const fs = require('fs');
const { User } = require('../models/user');
const KycRequest = require('../models/KycRequest');

/**
 * helper: تأخذ مسار فعلي على السيرفر وترجعه كمسار نسبي يبدأ بـ uploads/...
 * الهدف: تخزين مسار نظيف يمكن عرضه من خلال /uploads في الفرونت
 */
function toRelativeUploadPath(absolutePath) {
  if (!absolutePath) return null;
  // مثال:
  // absolutePath = E:\...\uploads\kyc\USERID\front.png
  // نريد: uploads/kyc/USERID/front.png
  const uploadsRoot = path.join(process.cwd(), 'uploads');
  const rel = path.relative(uploadsRoot, absolutePath).replace(/\\/g, '/'); // win -> url style
  return rel ? `uploads/${rel}` : null;
}

/**
 * تحقّق إذا المستخدم يملك صلاحيات دعم/ستاف/أدمن لعرض/إدارة KYC
 */
function isSupport(req) {
  const roleLower = String(
    req?.user?.roleLower || req?.user?.role || req?.user?.Role || ''
  )
    .toLowerCase()
    .trim();

  const allowed = [
    'support',
    'supportuser',
    'support_user',
    'support-agent',
    'supportagent',
    'staff',
    'admin',
    'kyc',
    'kyc_agent',
    'kycagent',
    'moderator',
    'manager',
  ];

  const ok = allowed.includes(roleLower);
  console.log('[KYC][isSupport] roleLower =', roleLower, '=> allowed?', ok);
  return ok;
}

/**
 * DELETE helper:
 * يحذف الملفين (الأمامي والخلفي) من السيرفر بعد الانتهاء من الطلب
 */
async function cleanupKycFiles(frontPathRel, backPathRel) {
  // frontPathRel مثل: "uploads/kyc/<userId>/front.png"
  const tryDelete = async (relPath) => {
    if (!relPath) return;
    const abs = path.join(process.cwd(), relPath.replace(/^uploads[\\/]/, 'uploads/'));
    try {
      await fs.promises.unlink(abs);
      console.log('[KYC cleanup] deleted', abs);
    } catch (err) {
      console.warn('[KYC cleanup] failed to delete', abs, err.message);
    }
  };

  await tryDelete(frontPathRel);
  await tryDelete(backPathRel);
}

/**
 * POST /api/kyc
 * رفع طلب KYC جديد
 */
exports.submit = async (req, res) => {
  try {
    if (!req.user?._id) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const files = req.files || {};
    const front = files.front?.[0];
    const back = files.back?.[0];

    if (!front || !back) {
      return res
        .status(400)
        .json({ message: 'Both front and back images are required' });
    }

    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // 🔒 إذا المستخدم أصلاً أصبح verified لا نسمح له يرفع مرّة ثانية
    if (user.kyc_status === 'verified') {
      return res.status(403).json({
        message: 'Your identity is already verified. You cannot submit again.',
      });
    }

    // هل لديه أصلاً طلب pending؟
    const hasPending = await KycRequest.findOne({
      user_id: user._id,
      status: 'pending',
    });

    if (hasPending) {
      return res.status(409).json({
        code: 'KYC_PENDING',
        message:
          'There is already a pending KYC request. Please wait for review.',
      });
    }

    // خزّن المسارات بشكل نسبي (بدل المسار المطلق E:\...)
    const frontRel = toRelativeUploadPath(front.path);
    const backRel = toRelativeUploadPath(back.path);

    const doc = await KycRequest.create({
      user_id: user._id,
      front_image_path: frontRel,
      back_image_path: backRel,
      status: 'pending',
    });

    // حدّث حالة المستخدم إلى "pending" فقط إذا لم يكن verified
    if (user.kyc_status !== 'verified') {
      user.kyc_status = 'pending';
      await user.save();
    }

    return res.status(201).json({ request: doc });
  } catch (e) {
    console.error('[KYC submit]', e);
    return res.status(500).json({ message: 'Internal error' });
  }
};

/**
 * GET /api/kyc/mine
 * يرجع آخر طلب KYC خاص بالمستخدم
 */
exports.mine = async (req, res) => {
  try {
    if (!req.user?._id) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const doc = await KycRequest.findOne({ user_id: req.user._id }).sort({
      created_at: -1,
    });

    return res.json({ request: doc || null });
  } catch (e) {
    console.error('[KYC mine]', e);
    return res.status(500).json({ message: 'Internal error' });
  }
};

/**
 * GET /api/kyc/pending
 * فقط للدعم / الأدمن: جلب قائمة الطلبات المعلّقة
 */
exports.pending = async (req, res) => {
  try {
    if (!isSupport(req)) {
      console.warn(
        '[KYC pending] Access denied. user.id=',
        req.user?._id,
        ' role=',
        req.user?.role,
        ' roleLower=',
        req.user?.roleLower
      );
      return res.status(403).json({ message: 'Forbidden' });
    }

    const list = await KycRequest.find({
      status: { $in: ['pending', 'Pending'] },
    })
      .populate('user_id', 'username email created_at kyc_status')
      .sort({ created_at: -1 });

    console.log('[KYC pending] returning', list.length, 'requests');

    return res.json({ requests: list });
  } catch (e) {
    console.error('[KYC pending]', e);
    return res.status(500).json({ message: 'Internal error' });
  }
};

/**
 * PATCH /api/kyc/:id/approve
 * قبول الطلب:
 * - تغيير status إلى approved
 * - user.kyc_status = 'verified'
 * - حذف الصور من السيرفر بعد ذلك
 * - ملاحظة: بعد الموافقة لن يسمح له بإرسال طلب جديد (تمت معالجتها في submit)
 */
exports.approve = async (req, res) => {
  try {
    if (!isSupport(req)) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    const { id } = req.params;

    const doc = await KycRequest.findById(id).populate(
      'user_id',
      '_id kyc_status'
    );
    if (!doc) {
      return res.status(404).json({ message: 'Request not found' });
    }
    if (doc.status !== 'pending') {
      return res.status(400).json({ message: 'Invalid status' });
    }

    doc.status = 'approved';
    doc.reviewed_by = req.user._id;
    doc.reviewed_at = new Date();
    await doc.save();

    // حدث المستخدم إلى verified (يبقى verified)
    await User.findByIdAndUpdate(doc.user_id._id, {
      $set: {
        kyc_status: 'verified',
        kyc_verified_at: new Date(),
      },
    });

    // بعد أن صار الطلب approved، نظف الصور من السيرفر
    await cleanupKycFiles(doc.front_image_path, doc.back_image_path);

    return res.json({ request: doc });
  } catch (e) {
    console.error('[KYC approve]', e);
    return res.status(500).json({ message: 'Internal error' });
  }
};

/**
 * PATCH /api/kyc/:id/reject
 * رفض الطلب:
 * - status => rejected
 * - user.kyc_status => 'unverified'
 * - حذف الصور لتوفير المساحة
 */
exports.reject = async (req, res) => {
  try {
    if (!isSupport(req)) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    const { id } = req.params;
    const { reason } = req.body || {};

    const doc = await KycRequest.findById(id).populate('user_id', '_id');
    if (!doc) {
      return res.status(404).json({ message: 'Request not found' });
    }
    if (doc.status !== 'pending') {
      return res.status(400).json({ message: 'Invalid status' });
    }

    doc.status = 'rejected';
    doc.reject_reason = reason || 'N/A';
    doc.reviewed_by = req.user._id;
    doc.reviewed_at = new Date();
    await doc.save();

    // ارجاع حالة المستخدم إلى unverified بحيث يقدر يرفع مرة ثانية
    await User.findByIdAndUpdate(doc.user_id._id, {
      $set: { kyc_status: 'unverified' },
    });

    // نظف الصور بعد الرفض أيضاً
    await cleanupKycFiles(doc.front_image_path, doc.back_image_path);

    return res.json({ request: doc });
  } catch (e) {
    console.error('[KYC reject]', e);
    return res.status(500).json({ message: 'Internal error' });
  }
};
