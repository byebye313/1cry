// controllers/supportPredictionController.js
const { SupportPrediction } = require('../models/SupportPrediction');
const { User } = require('../models/user');

function getFourHourWindowUTC(date = new Date()) {
  const d = new Date(date);
  const utcAligned = new Date(Date.UTC(
    d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), 0, 0, 0
  ));
  const hour = utcAligned.getUTCHours();
  const startHour = Math.floor(hour / 4) * 4; // 0,4,8,12,16,20
  const window_start = new Date(Date.UTC(
    utcAligned.getUTCFullYear(), utcAligned.getUTCMonth(), utcAligned.getUTCDate(), startHour, 0, 0, 0
  ));
  const window_end = new Date(window_start.getTime() + 4 * 60 * 60 * 1000);
  return { window_start, window_end };
}

async function upsertSupportPrediction(req, res) {
  try {
    const userId = req.user?._id || req.user?.id || req.body?.user_id || null;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const user = await User.findById(userId);
    if (!user || user.role !== 'Support') {
      return res.status(403).json({ message: 'Only Support can set prediction' });
    }

    const { value } = req.body;
    if (typeof value !== 'number' || !isFinite(value)) {
      return res.status(400).json({ message: 'Invalid value' });
    }

    const { window_start, window_end } = getFourHourWindowUTC(new Date());
    const doc = await SupportPrediction.findOneAndUpdate(
      { window_start, window_end },
      {
        $set: {
          value,
          source: 'support',
          created_by: user._id,
          updated_at: new Date(),
        },
        $setOnInsert: { created_at: new Date() },
      },
      { upsert: true, new: true }
    );

    return res.json({ ok: true, prediction: doc });
  } catch (e) {
    return res.status(400).json({ message: e.message });
  }
}

module.exports = {
  upsertSupportPrediction,
  getFourHourWindowUTC,
};
