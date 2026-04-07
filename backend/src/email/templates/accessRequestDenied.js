import { escapeHtml as esc } from '../escape.js';
import { renderLayout } from '../layout.js';

export function render({ recipientName, serverHostname, deniedReason }) {
  const subject = `[Shellius] Access denied: ${serverHostname}`;
  const safeName = esc(recipientName || 'there');
  const safeHost = esc(serverHostname);
  const safeReason = esc(deniedReason || '(no reason provided)');

  const bodyHtml = `
    <h1 style="margin:0 0 16px;font:600 22px/1.3 -apple-system,sans-serif;color:#0a0a0a">
      Your access request was denied
    </h1>
    <p style="margin:0 0 16px;font:400 15px/1.5 -apple-system,sans-serif;color:#3f3f46">
      Hi ${safeName}, your request to access <strong>${safeHost}</strong> was
      denied by a reviewer.
    </p>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0;width:100%;background:#fef2f2;border:1px solid #fecaca;border-radius:8px;">
      <tr><td style="padding:16px;font:400 13px/1.6 -apple-system,sans-serif;color:#7f1d1d">
        <strong>Reason:</strong> ${safeReason}
      </td></tr>
    </table>
    <p style="margin:0;font:400 13px/1.5 -apple-system,sans-serif;color:#71717a">
      You can submit a new request after addressing the reviewer's concerns.
    </p>
  `;

  const text = `Your access request to ${serverHostname} was denied.

Reason: ${deniedReason}`;

  return {
    subject,
    html: renderLayout({ title: subject, preheader: `Access to ${serverHostname} denied`, bodyHtml }),
    text,
  };
}
