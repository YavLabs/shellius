import { escapeHtml as esc } from '../escape.js';
import { renderLayout } from '../layout.js';
import { button } from '../button.js';

export function render({ recipientName, resetUrl, expiresInHours }) {
  const subject = '[Shellius] Reset your password';
  const safeName = esc(recipientName || 'there');
  const safeUrl = esc(resetUrl);
  const hours = Number(expiresInHours) || 1;

  const bodyHtml = `
    <h1 style="margin:0 0 16px;font:600 22px/1.3 -apple-system,sans-serif;color:#0a0a0a">
      Reset your password
    </h1>
    <p style="margin:0 0 16px;font:400 15px/1.5 -apple-system,sans-serif;color:#3f3f46">
      Hi ${safeName}, we received a request to reset the password on your Shellius
      account. Click the button below to choose a new one.
    </p>
    <div style="margin:32px 0;text-align:center">
      ${button({ href: safeUrl, label: 'Reset Password' })}
    </div>
    <p style="margin:0 0 8px;font:400 13px/1.5 -apple-system,sans-serif;color:#71717a">
      This link expires in ${hours} hour${hours === 1 ? '' : 's'}.
    </p>
    <p style="margin:0 0 12px;font:400 12px/1.5 -apple-system,sans-serif;color:#a1a1aa">
      If the button doesn't work, copy and paste this link into your browser:<br>
      <a href="${safeUrl}" style="color:#18181b;word-break:break-all">${safeUrl}</a>
    </p>
    <p style="margin:0;font:400 12px/1.5 -apple-system,sans-serif;color:#a1a1aa">
      If you did not request a password reset, you can safely ignore this email —
      your password will not be changed.
    </p>
  `;

  const text = `Reset your password

We received a request to reset your Shellius password.

Reset it here: ${resetUrl}

This link expires in ${hours} hour${hours === 1 ? '' : 's'}.

If you did not request this, ignore this email.`;

  return {
    subject,
    html: renderLayout({ title: subject, preheader: 'Reset your Shellius password', bodyHtml }),
    text,
  };
}
