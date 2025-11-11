// cors-origins.js
require('dotenv').config();

const csvToSet = (s) =>
  new Set((s || '')
    .split(',')
    .map(x => x.trim())
    .filter(Boolean));

const ALLOWED_ORIGINS = csvToSet(process.env.CORS_ORIGINS);
const ALLOW_NULL_ORIGIN = String(process.env.CORS_ALLOW_NULL).toLowerCase() === 'true';

const originFn = (origin, cb) => {
  // بدون default — كل شيء يمر فقط لو كان ضمن CORS_ORIGINS أو null مسموح به
  if (!origin && ALLOW_NULL_ORIGIN) return cb(null, true);
  if (origin && ALLOWED_ORIGINS.has(origin)) return cb(null, true);
  return cb(new Error(`Not allowed by CORS: ${origin || 'null'}`));
};

const isAllowedOrigin = (origin) => {
  if (!origin) return ALLOW_NULL_ORIGIN;
  return ALLOWED_ORIGINS.has(origin);
};

module.exports = { originFn, isAllowedOrigin };
