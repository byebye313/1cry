// services/emailTemplates/withdrawal.js

// ملاحظات تصميم:
// - بنية جداول (tables) لضمان التوافق مع Gmail/Outlook.
// - CSS inline قدر الإمكان.
// - preheader مخفي لتحسين معاينة البريد.
// - يدعم شعار عبر CID: logo@1cryptox (يُضاف من mailer إن توفر MAIL_LOGO_PATH).

const COLORS = {
  bg: '#0b0e11',
  card: '#12171d',
  border: '#1e2329',
  text: '#e6edf3',
  sub: '#a3b1c2',
  accent: '#f3ba2f',   // gold
  success: '#1db954',  // green
  danger: '#ff4d4f',
  link: '#2f81f7'
};

const SPACING = { container: 24, cardPad: 24, sectionGap: 16 };
const WIDTH = 600;

function preheader(text) {
  // نص معاينة مخفي
  return `
<span style="display:none !important;visibility:hidden;mso-hide:all;font-size:1px;line-height:1px;color:#ffffff;max-height:0;max-width:0;opacity:0;overflow:hidden;">
  ${text}
</span>`;
}

function logoOrBrand(brandName) {
  if (process.env.MAIL_LOGO_PATH) {
    return `<img src="cid:logo@1cryptox" alt="${brandName}" width="120" height="36" style="display:block;margin:0 auto;max-width:160px;height:auto" />`;
  }
  return `<div style="font-size:22px;font-weight:bold;color:${COLORS.accent};text-align:center">${brandName}</div>`;
}

function row(label, value) {
  return `
    <tr>
      <td style="padding:8px 12px;border:1px solid ${COLORS.border};color:${COLORS.sub};white-space:nowrap">${label}</td>
      <td style="padding:8px 12px;border:1px solid ${COLORS.border};color:${COLORS.text}">${value}</td>
    </tr>`;
}

function sectionTitle(text) {
  return `<h2 style="margin:${SPACING.sectionGap}px 0 8px;font-size:16px;line-height:1.4;color:${COLORS.text}">${text}</h2>`;
}

function cta(href, label) {
  return `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:${SPACING.sectionGap}px auto 0;">
      <tr>
        <td align="center" bgcolor="${COLORS.accent}" style="border-radius:8px;">
          <a href="${href}" style="display:inline-block;padding:12px 20px;font-weight:600;color:#0b0e11;text-decoration:none"> ${label} </a>
        </td>
      </tr>
    </table>`;
}

function shell({ title, subtitle, brandName, bodyHtml }) {
  return `
  <!doctype html>
  <html lang="en">
  <head>
    <meta http-equiv="Content-Type" content="text/html; charset=utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
  </head>
  <body style="margin:0;background:${COLORS.bg};font-family:Arial,Helvetica,sans-serif;color:${COLORS.text}">
    ${preheader(subtitle)}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${COLORS.bg};padding:${SPACING.container}px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="${WIDTH}" cellpadding="0" cellspacing="0" border="0" style="max-width:100%;background:${COLORS.card};border:1px solid ${COLORS.border};border-radius:12px;overflow:hidden">
            <tr>
              <td style="padding:18px 16px;border-bottom:1px solid ${COLORS.border};text-align:center">
                ${logoOrBrand(brandName)}
                <div style="font-size:12px;color:${COLORS.sub};margin-top:6px">Secure • Fast • Global</div>
              </td>
            </tr>
            <tr>
              <td style="padding:${SPACING.cardPad}px">
                <h1 style="margin:0 0 8px;font-size:20px;line-height:1.4">${title}</h1>
                <p style="margin:0 0 ${SPACING.sectionGap}px;color:${COLORS.sub};font-size:14px;line-height:1.6">${subtitle}</p>
                ${bodyHtml}
              </td>
            </tr>
            <tr>
              <td style="padding:14px 16px;border-top:1px solid ${COLORS.border};text-align:center;color:${COLORS.sub};font-size:12px">
                © ${new Date().getFullYear()} ${brandName} — All rights reserved.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
  </html>`;
}

/* ===================== TEMPLATES ===================== */

// البريد الوحيد المُفعّل: Completed (بدون TXID)
exports.completed = ({
  brandName = '1CryptoX',
  username,
  asset,
  amount,
  network,
  to,
  requestId,
  // txid,               // محذوف حسب السياسة الجديدة
  completedAt,
  // الحقول الجديدة للرسوم:
  priceUSDT,            // اختياري: إذا مرّرته من الكنترولر سيظهر (price_usdt)
  feeUSDT,              // 5 USDT ثابتة
  feeAsset,             // ما يعادل 5 USDT من أصل السحب
  networkFeePct,        // 0 لـ USDT، 0.01 لغيره
  networkFeeAsset,      // amount * pct (لغير USDT)
  totalFeeAsset,        // feeAsset + networkFeeAsset
  netAmount,            // amount - totalFeeAsset
  requestUrl
}) => {
  const title = 'Withdrawal Completed';
  const subtitle = `Dear ${username}, your ${asset} withdrawal has been successfully completed.`;

  // Summary
  const summaryTable = `
    ${sectionTitle('Summary')}
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;margin-top:8px">
      ${row('Asset', asset)}
      ${row('Amount', `${amount} ${asset}`)}
      ${row('Network', network)}
      ${row('To Address', to)}
      ${row('Request ID', requestId)}
      ${row('Completed At', new Date(completedAt).toLocaleString())}
      ${priceUSDT ? row('Price (USDT)', Number(priceUSDT).toFixed(4)) : ''}
    </table>`;

  // Fees
  const pctLabel = typeof networkFeePct === 'number'
    ? `${(networkFeePct * 100).toFixed(2)}%`
    : (networkFeePct ?? '') || ''; // لو undefined لن نعرض النسبة

  const feesTable = `
    ${sectionTitle('Fees')}
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;margin-top:8px">
      ${row('Platform fee', feeAsset != null
        ? `${Number(feeAsset).toFixed(8)} ${asset} (≈ ${Number(feeUSDT ?? 5).toFixed(2)} USDT)`
        : `${Number(feeUSDT ?? 5).toFixed(2)} USDT`
      )}
      ${row('Network fee', networkFeeAsset != null
        ? `${Number(networkFeeAsset).toFixed(8)} ${asset}${pctLabel ? ` (${pctLabel})` : ''}`
        : `0.00000000 ${asset}`
      )}
      ${row('Total fees', `${Number(totalFeeAsset ?? 0).toFixed(8)} ${asset}`)}
      ${row('Estimated net', `${Number(netAmount ?? 0).toFixed(8)} ${asset}`)}
    </table>`;

  const help = `
    <p style="margin:${SPACING.sectionGap}px 0 0;color:${COLORS.sub};font-size:13px;line-height:1.6">
      If you didn’t initiate this withdrawal, contact support immediately.
    </p>`;

  const btn = requestUrl ? cta(requestUrl, 'View Withdrawal') : '';

  return shell({
    brandName,
    title,
    subtitle,
    bodyHtml: `${summaryTable}${feesTable}${btn}${help}`
  });
};

// ملاحظة: نُبقي فقط قالب "completed" لأن البريد يُرسل عند الإكمال فقط.
// إن أردت لاحقًا قوالب أخرى (received/approved/rejected) نُضيفها بنفس النمط.
