import { escapeHtml as esc } from '../escape.js';
import { renderLayout } from '../layout.js';

/**
 * smtpTest email template.
 *
 * Sent from Settings → Notifications → "Send test email" so an admin can
 * confirm the SMTP configuration is reachable end-to-end and that the
 * styled HTML layout renders correctly in their inbox.
 *
 * Vars:
 *   recipientName {string} - display name of the admin who triggered the test
 *   orgName       {string} - organization name (for context)
 *   host          {string} - SMTP host that delivered the message
 *   port          {number} - SMTP port
 *   useTls        {bool}   - whether TLS was negotiated
 *   when          {string} - ISO timestamp the test was triggered
 */
export function render({ recipientName, orgName, host, port, useTls, when }) {
  const subject = '[Shellius] SMTP test message';
  const safeName = esc(recipientName || 'there');
  const safeOrg = esc(orgName || 'your organization');
  const safeHost = esc(host || 'unknown');
  const safePort = esc(String(port ?? ''));
  const safeTls = useTls ? 'enabled' : 'disabled';
  const safeWhen = esc(when || new Date().toISOString());

  const bodyHtml = `
    <h1 style="margin:0 0 16px;font:600 22px/1.3 -apple-system,sans-serif;color:#0a0a0a">
      SMTP test successful
    </h1>
    <p style="margin:0 0 16px;font:400 15px/1.5 -apple-system,sans-serif;color:#3f3f46">
      Hi ${safeName}, this is a test message from Shellius confirming that
      the outbound SMTP configuration for <strong>${safeOrg}</strong> is
      working. If you are reading this in your inbox, you are good to go.
    </p>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0;width:100%;background:#fafafa;border:1px solid #e4e4e7;border-radius:8px;">
      <tr><td style="padding:16px;font:400 13px/1.6 -apple-system,sans-serif;color:#3f3f46">
        <strong>Host:</strong> ${safeHost}<br>
        <strong>Port:</strong> ${safePort}<br>
        <strong>TLS:</strong> ${safeTls}<br>
        <strong>Sent at:</strong> ${safeWhen}
      </td></tr>
    </table>
    <p style="margin:0;font:400 13px/1.5 -apple-system,sans-serif;color:#71717a">
      No action is required. You can safely delete this message.
    </p>
  `;

  const text = `SMTP test successful

Hi ${recipientName || 'there'}, this is a test message from Shellius
confirming that the outbound SMTP configuration for ${orgName || 'your organization'}
is working.

Host: ${host}
Port: ${port}
TLS:  ${useTls ? 'enabled' : 'disabled'}
Sent: ${when}

No action is required. You can safely delete this message.`;

  return {
    subject,
    html: renderLayout({ title: subject, preheader: 'SMTP configuration test', bodyHtml }),
    text,
  };
}
