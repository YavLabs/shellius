import { escapeHtml as esc } from '../escape.js';
import { renderLayout } from '../layout.js';

// `added: true` — a password was set on an account that had none (an
// SSO-only user adding one from Profile). Same alert, different wording.
export function render({ recipientName, ipAddress, userAgent, when, added = false }) {
  const verb = added ? 'added to your account' : 'changed';
  const subject = added ? '[Shellius] A password was added to your account' : '[Shellius] Your password was changed';
  const safeName = esc(recipientName || 'there');
  const safeIp = esc(ipAddress || 'unknown');
  const safeUa = esc(userAgent || 'unknown');
  const safeWhen = esc(when || new Date().toISOString());

  const bodyHtml = `
    <h1 style="margin:0 0 16px;font:600 22px/1.3 -apple-system,sans-serif;color:#09090C">
      ${added ? 'A password was added' : 'Your password was changed'}
    </h1>
    <p style="margin:0 0 16px;font:400 15px/1.5 -apple-system,sans-serif;color:#3f3f46">
      Hi ${safeName}, this is a security notification confirming that your
      ${added ? 'account can now also be signed in to with a password' : 'Shellius password was changed'}.
    </p>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0;width:100%;background:#fafafa;border:1px solid #e4e4e7;border-radius:8px;">
      <tr><td style="padding:16px;font:400 13px/1.6 -apple-system,sans-serif;color:#3f3f46">
        <strong>When:</strong> ${safeWhen}<br>
        <strong>IP address:</strong> ${safeIp}<br>
        <strong>Device:</strong> ${safeUa}
      </td></tr>
    </table>
    <p style="margin:0;font:400 13px/1.5 -apple-system,sans-serif;color:#dc2626">
      <strong>If this wasn't you</strong>, your account may be compromised.
      Contact your administrator immediately.
    </p>
  `;

  const text = `A password was ${added ? 'added to your Shellius account' : 'changed on your Shellius account'}.

When: ${when}
IP: ${ipAddress}
Device: ${userAgent}

If this wasn't you, contact your administrator immediately.`;

  return {
    subject,
    html: renderLayout({ title: subject, preheader: `Security alert: password ${verb}`, bodyHtml }),
    text,
  };
}
