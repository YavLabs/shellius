import { escapeHtml as esc } from '../escape.js';
import { renderLayout } from '../layout.js';
import { button } from '../button.js';

export function render({ recipientName, orgName, inviteUrl, expiresInHours }) {
  const subject = `[Shellius] You're invited to join ${orgName || 'Shellius'}`;
  const safeName = esc(recipientName || 'there');
  const safeOrg = esc(orgName || 'Shellius');
  const safeUrl = esc(inviteUrl);
  const hours = Number(expiresInHours) || 168;

  const bodyHtml = `
    <h1 style="margin:0 0 16px;font:600 22px/1.3 -apple-system,sans-serif;color:#0a0a0a">
      You've been invited to ${safeOrg}
    </h1>
    <p style="margin:0 0 16px;font:400 15px/1.5 -apple-system,sans-serif;color:#3f3f46">
      Hi ${safeName}, an administrator at <strong>${safeOrg}</strong> has invited you
      to join their Shellius instance. Click the button below to set your password
      and get started.
    </p>
    <div style="margin:32px 0;text-align:center">
      ${button({ href: safeUrl, label: 'Accept Invitation' })}
    </div>
    <p style="margin:0 0 8px;font:400 13px/1.5 -apple-system,sans-serif;color:#71717a">
      This invitation expires in ${hours} hours.
    </p>
    <p style="margin:0;font:400 12px/1.5 -apple-system,sans-serif;color:#a1a1aa">
      If the button doesn't work, copy and paste this link into your browser:<br>
      <a href="${safeUrl}" style="color:#10b981;word-break:break-all">${safeUrl}</a>
    </p>
  `;

  const text = `You've been invited to ${orgName || 'Shellius'} on Shellius.

Set your password and accept the invitation:
${inviteUrl}

This link expires in ${hours} hours.`;

  return {
    subject,
    html: renderLayout({ title: subject, preheader: `Set your password to join ${safeOrg}`, bodyHtml }),
    text,
  };
}
