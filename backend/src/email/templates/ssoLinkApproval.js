import { escapeHtml as esc } from '../escape.js';
import { renderLayout } from '../layout.js';
import { button } from '../button.js';

/**
 * One-time approval link for linking an SSO identity to a privileged account
 * that has no password to confirm with (docs/auth-hardening.md "Linking SSO
 * accounts").
 */
export function render({ recipientName, providerName, identityEmail, approveUrl, expiresInMinutes, ipAddress }) {
  const provider = providerName || 'single sign-on';
  const subject = `[Shellius] Approve linking your ${provider} account`;
  const safeName = esc(recipientName || 'there');
  const safeProvider = esc(provider);
  const safeIdentity = esc(identityEmail || 'unknown');
  const safeUrl = esc(approveUrl);
  const safeIp = esc(ipAddress || 'unknown');
  const minutes = Number(expiresInMinutes) || 30;

  const bodyHtml = `
    <h1 style="margin:0 0 16px;font:600 22px/1.3 -apple-system,sans-serif;color:#0a0a0a">
      Approve linking ${safeProvider}
    </h1>
    <p style="margin:0 0 16px;font:400 15px/1.5 -apple-system,sans-serif;color:#3f3f46">
      Hi ${safeName}, someone signed in with the ${safeProvider} account
      <strong>${safeIdentity}</strong> and asked to link it to your Shellius account.
      Because your account has administrative permissions, linking needs your approval.
    </p>
    <div style="margin:32px 0;text-align:center">
      ${button({ href: safeUrl, label: 'Review and approve' })}
    </div>
    <p style="margin:0 0 8px;font:400 13px/1.5 -apple-system,sans-serif;color:#71717a">
      This link expires in ${minutes} minutes and can be used once. Requested from IP ${safeIp}.
    </p>
    <p style="margin:0 0 12px;font:400 12px/1.5 -apple-system,sans-serif;color:#a1a1aa">
      If the button doesn't work, copy and paste this link into your browser:<br>
      <a href="${safeUrl}" style="color:#18181b;word-break:break-all">${safeUrl}</a>
    </p>
    <p style="margin:0;font:400 13px/1.5 -apple-system,sans-serif;color:#dc2626">
      <strong>If this wasn't you</strong>, don't open the link and contact your administrator.
    </p>
  `;

  const text = `Approve linking your ${provider} account

Someone signed in with the ${provider} account ${identityEmail || 'unknown'} and asked to link it to your Shellius account. Because your account has administrative permissions, linking needs your approval.

Review and approve: ${approveUrl}

This link expires in ${minutes} minutes and can be used once. Requested from IP ${ipAddress || 'unknown'}.

If this wasn't you, don't open the link and contact your administrator.`;

  return {
    subject,
    html: renderLayout({ title: subject, preheader: `Approve linking ${provider} to your Shellius account`, bodyHtml }),
    text,
  };
}
