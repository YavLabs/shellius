import { escapeHtml as esc } from '../escape.js';
import { renderLayout } from '../layout.js';
import { button } from '../button.js';

export function render({ recipientName, serverHostname, environment, expiresAt, connectUrl, reason }) {
  const subject = `[Shellius] Access approved: ${serverHostname}`;
  const safeName = esc(recipientName || 'there');
  const safeHost = esc(serverHostname);
  const safeEnv = esc(environment || 'unknown');
  const safeExpires = esc(expiresAt || '');
  const safeUrl = esc(connectUrl);
  const safeReason = esc(reason || '');

  const reasonBlock = reason
    ? `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px;width:100%;background:#f4f4f5;border:1px solid #e4e4e7;border-radius:8px;">
      <tr><td style="padding:12px 16px;font:400 12px/1.5 -apple-system,sans-serif;color:#52525b">
        <div style="font-weight:600;color:#3f3f46;margin-bottom:4px">Reason you provided</div>
        ${safeReason}
      </td></tr>
    </table>`
    : '';

  const bodyHtml = `
    <h1 style="margin:0 0 16px;font:600 22px/1.3 -apple-system,sans-serif;color:#0a0a0a">
      Your access request was approved ✓
    </h1>
    <p style="margin:0 0 16px;font:400 15px/1.5 -apple-system,sans-serif;color:#3f3f46">
      Hi ${safeName}, your request to access <strong>${safeHost}</strong>
      (${safeEnv}) has been approved. You can now connect.
    </p>
    ${reasonBlock}
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0;width:100%;background:#ecfdf5;border:1px solid #a7f3d0;border-radius:8px;">
      <tr><td style="padding:16px;font:400 13px/1.6 -apple-system,sans-serif;color:#065f46">
        <strong>Expires at:</strong> ${safeExpires}
      </td></tr>
    </table>
    <div style="margin:32px 0;text-align:center">
      ${button({ href: safeUrl, label: 'Open Connection' })}
    </div>
  `;

  const text = `Your access request was approved.

Server: ${serverHostname} (${environment})
${reason ? `Reason: ${reason}\n` : ''}Expires at: ${expiresAt}

Connect at: ${connectUrl}`;

  return {
    subject,
    html: renderLayout({ title: subject, preheader: `Access to ${serverHostname} approved`, bodyHtml }),
    text,
  };
}
