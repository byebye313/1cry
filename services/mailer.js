// services/mailer.js
// Gmail SMTP with safe fallbacks: skip missing logo, retry on transient errors, and
// gracefully degrade to sending WITHOUT attachments if attachments cause ESTREAM/ENOENT errors.

const nodemailer = require('nodemailer');
const fs = require('fs');

const SMTP_HOST = process.env.SMTP_HOST || 'smtp.gmail.com';
const SMTP_PORT = Number(process.env.SMTP_PORT || 465);
const SMTP_USER = process.env.SMTP_USER; // your@gmail.com
const SMTP_PASS = process.env.SMTP_PASS; // App Password (from Google -> Security -> App Passwords)
const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER;
const SMTP_SERVICE = process.env.SMTP_SERVICE || 'gmail';
const MAIL_LOGO_PATH = process.env.MAIL_LOGO_PATH || '';

if (!SMTP_USER || !SMTP_PASS) {
  console.warn('[mailer] Missing SMTP_USER/SMTP_PASS. Emails will fail until set.');
}

const transporter = nodemailer.createTransport({
  pool: true,
  service: SMTP_SERVICE,   // 'gmail'
  host: SMTP_HOST,         // 'smtp.gmail.com'
  port: SMTP_PORT,         // 465
  secure: true,
  auth: { user: SMTP_USER, pass: SMTP_PASS },
  tls: { minVersion: 'TLSv1.2' },
});

async function verifyTransporter() {
  try {
    await transporter.verify();
    console.log('[mailer] SMTP OK (gmail).');
  } catch (err) {
    console.error('[mailer] SMTP verify failed:', err.message);
  }
}
verifyTransporter().catch(() => {});

function htmlToText(html = '') {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// --- helpers for attachments (logo) ---
function buildLogoAttachmentIfExists() {
  try {
    if (!MAIL_LOGO_PATH) return null;
    if (!fs.existsSync(MAIL_LOGO_PATH)) {
      console.warn('[mailer] MAIL_LOGO_PATH does not exist, skipping logo attachment:', MAIL_LOGO_PATH);
      return null;
    }
    return { filename: 'logo.png', path: MAIL_LOGO_PATH, cid: 'logo@1cryptox' };
  } catch (e) {
    console.warn('[mailer] logo check error, skipping logo attachment:', e.message || e);
    return null;
  }
}

const TRANSIENT_CODES = new Set(['ETIMEDOUT', 'ECONNECTION', 'ESOCKET', 'EDNS', 'ETIMEOUT']);
const ATTACHMENT_CODES = new Set(['ENOENT', 'ESTREAM']);

// Core sender (optionally with attachments)
async function sendCore({ to, subject, html = '', text, attachments = [], headers = {}, category = 'general' }) {
  if (!to || !subject) throw new Error('sendMail: "to" and "subject" are required.');

  const mailOptions = {
    from: `"1CryptoX" <${SMTP_FROM}>`,
    to,
    subject,
    html,
    text: text || htmlToText(html),
    attachments,
    headers: {
      'X-1CryptoX-Category': category,
      ...headers,
    },
  };

  const RETRIES = 2;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    try {
      const info = await transporter.sendMail(mailOptions);
      console.log('[mailer] sent:', info.messageId, 'to:', to, attachments?.length ? '(with attachments)' : '(no attachments)');
      return info;
    } catch (err) {
      const code = err && (err.code || err.errno);
      const isTransient = TRANSIENT_CODES.has(code);
      const isAttachmentIssue = ATTACHMENT_CODES.has(code);
      const lastTry = attempt === RETRIES;
      console.error(`[mailer] send failed (attempt ${attempt+1}/${RETRIES+1}) ->`, code || err.message);

      // If it's NOT transient and NOT attachment-related, no point retrying twice
      if (!isTransient && !isAttachmentIssue) {
        if (!lastTry) {
          // still do linear backoff once for safety
          await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
          continue;
        }
        throw err;
      }

      // Transient: backoff and retry
      if (isTransient && !lastTry) {
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }

      // Attachment issue (ENOENT / ESTREAM): bail out now (caller will retry without attachments)
      throw err;
    }
  }
}

// Public API: try with attachments, and if they break, retry without them.
async function sendMail({ to, subject, html = '', text, attachments = [], headers = {}, category = 'general' }) {
  try {
    return await sendCore({ to, subject, html, text, attachments, headers, category });
  } catch (err) {
    const code = err && (err.code || err.errno);
    if (ATTACHMENT_CODES.has(code)) {
      console.warn('[mailer] attachment error detected (', code, '), retrying WITHOUT attachments...');
      // Retry without attachments
      return await sendCore({ to, subject, html, text, attachments: [], headers, category });
    }
    throw err;
  }
}

// Safe wrappers (never throw)
async function sendMailSafe(args) {
  try {
    const info = await sendMail(args);
    return { ok: true, info };
  } catch (error) {
    console.error('[mailer] sendMailSafe error:', error && (error.stack || error.message || error));
    return { ok: false, error: String(error.message || error) };
  }
}

async function sendMailWithLogo({ to, subject, html, text, category, headers }) {
  const attachments = [];
  const logo = buildLogoAttachmentIfExists();
  if (logo) attachments.push(logo);
  return sendMail({ to, subject, html, text, attachments, category, headers });
}

async function sendMailWithLogoSafe({ to, subject, html, text, category, headers }) {
  try {
    const attachments = [];
    const logo = buildLogoAttachmentIfExists();
    if (logo) attachments.push(logo);
    const info = await sendMail({ to, subject, html, text, attachments, category, headers });
    return { ok: true, info };
  } catch (error) {
    console.error('[mailer] sendMailWithLogoSafe error:', error && (error.stack || error.message || error));
    // As an extra safeguard, try one last time with absolutely NO attachments
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
