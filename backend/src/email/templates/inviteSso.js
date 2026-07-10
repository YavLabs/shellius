import { escapeHtml as esc } from '../escape.js';
import { renderLayout } from '../layout.js';
import { button } from '../button.js';

/**
 * Invite email for orgs where SSO is enabled. The user does NOT set a password
 * — they simply sign in with the org's identity provider, which links to their
 * account by email and activates it on first sign-in.
 */
export function render({ recipientName, orgName, loginUrl, providerLabel }) {
  const subject = `[Shellius] You're invited to join ${orgName || 'Shellius'}`;
  const safeName = esc(recipientName || 'there');
  const safeOrg = esc(orgName || 'Shellius');
  const safeUrl = esc(loginUrl);
  const safeProvider = esc(providerLabel || 'single sign-on');

  const bodyHtml = `
    <h1 style="margin:0 0 16px;font:600 22px/1.3 -apple-system,sans-serif;color:#0a0a0a">
      You've been invited to ${safeOrg}
    </h1>
    <p style="margin:0 0 16px;font:400 15px/1.5 -apple-system,sans-serif;color:#3f3f46">
      Hi ${safeName}, an administrator at <strong>${safeOrg}</strong> has added you to
      their Shellius instance. No password to set — just sign in with
      <strong>${safeProvider}</strong> using this email address and you're in.
    </p>
    <div style="margin:32px 0;text-align:center">
      ${button({ href: safeUrl, label: 'Sign in' })}
    </div>
    <p style="margin:0;font:400 12px/1.5 -apple-system,sans-serif;color:#a1a1aa">
      If the button doesn't work, copy and paste this link into your browser:<br>
      <a href="${safeUrl}" style="color:#18181b;word-break:break-all">${safeUrl}</a>
    </p>
  `;

  const text = `You've been invited to ${orgName || 'Shellius'} on Shellius.

Sign in with ${providerLabel || 'single sign-on'} using this email address:
${loginUrl}

No password needed.`;

  return {
    subject,
    html: renderLayout({ title: subject, preheader: `Sign in with ${safeProvider} to join ${safeOrg}`, bodyHtml }),
    text,
  };
}
