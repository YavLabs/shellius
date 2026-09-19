import { escapeHtml as esc } from '../escape.js';
import { renderLayout } from '../layout.js';

/**
 * Security notification: an SSO identity was unlinked from the account —
 * by the user themselves or by an administrator.
 */
export function render({ recipientName, providerName, identityEmail, byAdmin, when }) {
  const provider = providerName || 'single sign-on';
  const subject = `[Shellius] A ${provider} account was unlinked from your account`;
  const safeName = esc(recipientName || 'there');
  const safeProvider = esc(provider);
  const safeIdentity = esc(identityEmail || 'unknown');
  const safeWhen = esc(when || new Date().toISOString());
  const who = byAdmin ? 'by an administrator' : 'from your profile';

  const bodyHtml = `
    <h1 style="margin:0 0 16px;font:600 22px/1.3 -apple-system,sans-serif;color:#0a0a0a">
      ${safeProvider} account unlinked
    </h1>
    <p style="margin:0 0 16px;font:400 15px/1.5 -apple-system,sans-serif;color:#3f3f46">
      Hi ${safeName}, a ${safeProvider} account was unlinked from your Shellius account ${who}.
      You can no longer sign in with it.
    </p>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0;width:100%;background:#fafafa;border:1px solid #e4e4e7;border-radius:8px;">
      <tr><td style="padding:16px;font:400 13px/1.6 -apple-system,sans-serif;color:#3f3f46">
        <strong>Provider:</strong> ${safeProvider}<br>
        <strong>Account:</strong> ${safeIdentity}<br>
        <strong>When:</strong> ${safeWhen}
      </td></tr>
    </table>
    <p style="margin:0;font:400 13px/1.5 -apple-system,sans-serif;color:#dc2626">
      <strong>If this wasn't you</strong>, contact your administrator.
    </p>
  `;

  const text = `A ${provider} account was unlinked from your Shellius account ${who}.

Provider: ${provider}
Account: ${identityEmail || 'unknown'}
When: ${when || new Date().toISOString()}

If this wasn't you, contact your administrator.`;

  return {
    subject,
    html: renderLayout({ title: subject, preheader: `Security alert: ${provider} account unlinked`, bodyHtml }),
    text,
  };
}
