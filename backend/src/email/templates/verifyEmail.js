import { escapeHtml as esc } from '../escape.js';
import { renderLayout } from '../layout.js';
import { button } from '../button.js';

/**
 * verifyEmail email template.
 *
 * Vars:
 *   recipientName  {string} - display name
 *   verifyUrl      {string} - one-time verification link
 *   expiresInHours {number} - token TTL
 */
export function render({ recipientName, verifyUrl, expiresInHours = 24 }) {
  const subject = '[Shellius] Verify your email address';
  const safeName = esc(recipientName || 'there');
  const safeUrl = esc(verifyUrl);
  const hours = Number(expiresInHours) || 24;

  const bodyHtml = `
    <h1 style="margin:0 0 16px;font:600 22px/1.3 -apple-system,sans-serif;color:#0a0a0a">
      Verify your email address
    </h1>
    <p style="margin:0 0 16px;font:400 15px/1.5 -apple-system,sans-serif;color:#3f3f46">
      Hi ${safeName}, thanks for registering with Shellius. Please verify your email
      address to activate your account.
    </p>
    <div style="margin:32px 0;text-align:center">
      ${button({ href: safeUrl, label: 'Verify Email Address' })}
    </div>
    <p style="margin:0 0 8px;font:400 13px/1.5 -apple-system,sans-serif;color:#71717a">
      This link expires in ${hours} hours.
    </p>
    <p style="margin:0;font:400 12px/1.5 -apple-system,sans-serif;color:#a1a1aa">
      If the button doesn't work, copy and paste this link into your browser:<br>
      <a href="${safeUrl}" style="color:#10b981;word-break:break-all">${safeUrl}</a>
    </p>
    <p style="margin:16px 0 0;font:400 12px/1.5 -apple-system,sans-serif;color:#a1a1aa">
      If you did not create an account with Shellius, you can safely ignore this email.
    </p>
  `;

  const text = `Verify your Shellius email address.

Hi ${recipientName || 'there'}, please click the link below to verify your email and activate your account:

${verifyUrl}

This link expires in ${hours} hours.

If you did not create an account with Shellius, you can safely ignore this email.`;

  return {
    subject,
    html: renderLayout({ title: subject, preheader: 'Verify your email to activate your Shellius account', bodyHtml }),
    text,
  };
}
