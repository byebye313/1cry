// services/mailer.js
const nodemailer = require('nodemailer');
const fs = require('fs');

const SMTP_HOST = process.env.SMTP_HOST || 'smtp.gmail.com';
const SMTP_PORT = Number(process.env.SMTP_PORT || 465);
const SMTP_USER = process.env.SMTP_USER; // your@gmail.com
const SMTP_PASS = process.env.SMTP_PASS; // App Password
const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER;
const SMTP_SERVICE = process.env.SMTP_SERVICE || 'gmail';
const MAIL_LOGO_PATH = process.env.MAIL_LOGO_PATH || '';

if (!SMTP_USER || !SMTP_PASS) {
  console.warn('[mailer] Missing SMTP_USER/SMTP_PASS in env. Mail sending will likely fail.');
}

const transporter = nodemailer.createTransport({
  pool: true,
  service: SMTP_SERVICE,
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: true,
  auth: { user: SMTP_USER, pass: SMTP_PASS },
  tls: { minVersion: 'TLSv1.2' },
});

async function verifyTransporter() {
  try { await transporter.verify(); return true; }
  catch (e) { console.warn('[mailer] verify failed:', e && (e.message || e)); return false; }
}

function readLogoIfExists() {
  try {
    if (!MAIL_LOGO_PATH) return null;
    const buf = fs.readFileSync(MAIL_LOGO_PATH);
    return { filename: 'logo.png', content: buf, cid: 'app-logo@local' };
  } catch (e) {
    console.warn('[mailer] logo not found/ignored:', e && (e.message || e));
    return null;
  }
}

async function sendCore({ to, subject, html, text, attachments = [], category, headers = {} }) {
  const info = await transporter.sendMail({
    from: SMTP_FROM,
    to,
    subject,
    html,
    text,
    attachments,
    headers: { 'X-Category': category || 'general', ...headers },
  });
  return info;
}

async function sendMail({ to, subject, html, text, attachments, category, headers }) {
  await verifyTransporter();
  return sendCore({ to, subject, html, text, attachments, category, headers });
}

async function sendMailSafe({ to, subject, html, text, attachments = [], category, headers }) {
  try {
    const info = await sendMail({ to, subject, html, text, attachments, category, headers });
    return { ok: true, info };
  } catch (error) {
    return { ok: false, error: String(error.message || error) };
  }
}

async function sendMailWithLogo({ to, subject, html, text, attachments = [], category, headers }) {
  const logoAttachment = readLogoIfExists();
  const finalAttachments = logoAttachment ? [...attachments, logoAttachment] : attachments;
  return sendMail({ to, subject, html, text, attachments: finalAttachments, category, headers });
}

async function sendMailWithLogoSafe({ to, subject, html, text, attachments = [], category, headers }) {
  try {
    const info = await sendMailWithLogo({ to, subject, html, text, attachments, category, headers });
    return { ok: true, info };
  } catch (error) {
    console.error('[mailer] sendMailWithLogoSafe error:', error && (error.stack || error.message || error));
    try {
      const info2 = await sendCore({ to, subject, html, text, attachments: [], category, headers });
      console.warn('[mailer] sent without attachments as fallback.');
      return { ok: true, info: info2 };
    } catch (e2) {
      console.error('[mailer] fallback without attachments failed:', e2 && (e2.stack || e2.message || e2));
      return { ok: false, error: String(e2.message || e2) };
    }
  }
}

module.exports = { sendMail, sendMailSafe, sendMailWithLogo, sendMailWithLogoSafe };
