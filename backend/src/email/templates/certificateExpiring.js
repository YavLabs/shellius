import { escapeHtml as esc } from '../escape.js';
import { renderLayout } from '../layout.js';
import { button } from '../button.js';

export function render({ recipientName, serverHostname, expiresAt, renewUrl }) {
  const subject = `[Shellius] Access expiring soon: ${serverHostname}`;
  const safeName = esc(recipientName || 'there');
  const safeHost = esc(serverHostname);
  const safeExpires = esc(expiresAt || '');
  const safeUrl = esc(renewUrl);

  const bodyHtml = `
    <h1 style="margin:0 0 16px;font:600 22px/1.3 -apple-system,sans-serif;color:#0a0a0a">
      Your access is expiring soon
    </h1>
    <p style="margin:0 0 16px;font:400 15px/1.5 -apple-system,sans-serif;color:#3f3f46">
      Hi ${safeName}, your active access to <strong>${safeHost}</strong> will
      expire at ${safeExpires}. If you still need access, request a new session.
    </p>
    <div style="margin:32px 0;text-align:center">
      ${button({ href: safeUrl, label: 'Request New Access' })}
    </div>
  `;

  const text = `Your access to ${serverHostname} expires at ${expiresAt}.

Request a new session: ${renewUrl}`;

  return {
    subject,
    html: renderLayout({ title: subject, preheader: `Renew access to ${serverHostname}`, bodyHtml }),
    text,
  };
}
