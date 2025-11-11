// cors-origins.js
require('dotenv').config();

const RAW = process.env.CORS_ORIGINS || '';
const ALLOW_NULL = String(process.env.CORS_ALLOW_NULL || 'false').toLowerCase() === 'true';

// قوائم الدومينات
// - نقسم بالقُطع على ',' ثم نزيل المسافات ونحذف الفراغات الفارغة
// - نوحد الشكل: بدون سلاش ختامي، ونحتفظ بالبروتوكول (http/https)
const allowedOrigins = RAW.split(',')
  .map(s => s.trim())
  .filter(Boolean)
  .map(o => o.replace(/\/+$/, '')); // remove trailing slashes

// خيار اختياري: السماح بكل الساب-دومين على نطاقك الأساسي
// فعّل لو حاب تسمح لأي subdomain تحت 1cryptox.com
const BASE_DOMAIN = process.env.CORS_BASE_DOMAIN || '1cryptox.com';
const allowAllSubdomains = String(process.env.CORS_ALLOW_SUBDOMAINS || 'true').toLowerCase() === 'true';

function normalize(url) {
  // نطبع بدون السلاش الختامي
  return (url || '').replace(/\/+$/, '');
}

// فحص دقيق للمطابقة:
// - يسمح بالـ null/undefined إذا ALLOW_NULL=true (لازم لتطبيقات الموبايل/React Native)
// - يسمح بالمطابقة الحرفية مع العناصر في allowedOrigins
// - يسمح اختياريًا بأي ساب-دومين ينتهي بـ .BASE_DOMAIN (مع نفس البروتوكول إن وُجد)
function isAllowedOrigin(origin) {
  if (!origin) return ALLOW_NULL;

  const o = normalize(origin);

  // مطابقة حرفية
  if (allowedOrigins.includes(o)) return true;

  // ساب-دومينات (اختياري)
  if (allowAllSubdomains) {
    try {
      const u = new URL(o);
      // يمرّر https://app.1cryptox.com و https://api.1cryptox.com إلخ
      if (u.hostname === BASE_DOMAIN || u.hostname.endsWith('.' + BASE_DOMAIN)) {
        // لو تبغى تقيد البروتوكول بالـ https فقط، فعّل السطر التالي:
        // if (u.protocol !== 'https:') return false;
        return true;
      }
    } catch (_) {
      // لو origin نصي غريب، نرجع false
      return false;
    }
  }

  return false;
}

// دالة origin لِـ cors/Socket.IO
function originFn(origin, callback) {
  const ok = isAllowedOrigin(origin);
  // DEBUG اختياري: اطبع كل Origin داخل اللوج لمرة التشخيص
  if (process.env.CORS_DEBUG === 'true') {
    console.log('[CORS] origin =', origin, '=>', ok ? 'ALLOWED' : 'BLOCKED');
  }
  if (ok) return callback(null, true);
  return callback(new Error('Not allowed by CORS'));
}

module.exports = { originFn, isAllowedOrigin, allowedOrigins };
