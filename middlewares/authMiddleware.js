// middlewares/authMiddleware.js
const jwt = require('jsonwebtoken');

const authMiddleware = (req, res, next) => {
  try {
    // يدعم حالات الأحرف المختلفة
    const authHeader = req.headers.authorization || req.headers.Authorization;

    if (!authHeader || typeof authHeader !== 'string') {
      return res.status(401).json({ message: 'Authorization header is missing or invalid' });
    }

    // صيغة: "Bearer <token>"
    const parts = authHeader.split(' ');
    if (parts.length !== 2 || !/^Bearer$/i.test(parts[0])) {
      return res.status(401).json({ message: 'Invalid Authorization format' });
    }

    const token = parts[1]?.trim();
    if (!token) {
      return res.status(401).json({ message: 'No token provided, authorization denied' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key');

    // تطبيع الحقول ليضمن وجود _id دائمًا
    req.user = {
      _id: decoded._id || decoded.id || decoded.userId || null,
      email: decoded.email || null,
      role: decoded.role || decoded.Role || 'user',
      // إن أردت تمرير خصائص أخرى احتفظ بها:
      ...decoded,
    };

    if (!req.user._id && !req.user.email) {
      return res.status(401).json({ message: 'Unauthorized (invalid payload)' });
    }

    next();
  } catch (error) {
    console.error('Token verification error:', error.message);
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ message: 'Token has expired, please log in again' });
    }
    return res.status(401).json({ message: 'Invalid token, authorization denied' });
  }
};

module.exports = authMiddleware;
