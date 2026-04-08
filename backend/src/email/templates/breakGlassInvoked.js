import { escapeHtml as esc } from '../escape.js';
import { renderLayout } from '../layout.js';

/**
 * Email template for break-glass access invocation.
 *
 * Sent to every admin / super_admin in the org when an admin uses the
 * emergency break-glass flow to obtain immediate access to a server.
 *
 * @param {object} params
 * @param {string} params.recipientName   - Name of the admin receiving the notification
 * @param {string} params.invokerName     - Name of the admin who invoked break-glass
 * @param {string} params.serverHostname  - Target server hostname
 * @param {string} params.environment     - Server environment (prod / staging / etc.)
 * @param {string} params.reason          - Mandatory reason provided by the invoker
 * @param {string} params.expiresAt       - ISO string when access expires
 * @param {string} params.auditUrl        - Link to the audit log entry
 */
export function render({ recipientName, invokerName, serverHostname, environment, reason, expiresAt, auditUrl }) {
  const subject = `[Shellius] ALERT: Break-glass access invoked — ${serverHostname}`;
  const safeName = esc(recipientName || 'Admin');
  const safeInvoker = esc(invokerName || 'An administrator');
  const safeHost = esc(serverHostname);
  const safeEnv = esc(environment || 'unknown');
  const safeReason = esc(reason || '(no reason provided)');
  const safeExpires = esc(expiresAt || '');
  const safeUrl = esc(auditUrl || '');

  const bodyHtml = `
    <h1 style="margin:0 0 16px;font:600 22px/1.3 -apple-system,sans-serif;color:#dc2626">
      Break-glass access invoked
    </h1>
    <p style="margin:0 0 16px;font:400 15px/1.5 -apple-system,sans-serif;color:#3f3f46">
      Hi ${safeName}, <strong>${safeInvoker}</strong> has invoked emergency break-glass access
      to a server in your organisation. All administrators have been notified.
    </p>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0;width:100%;background:#fef2f2;border:1px solid #fecaca;border-radius:8px;">
      <tr><td style="padding:16px;font:400 13px/1.6 -apple-system,sans-serif;color:#7f1d1d">
        <strong>Server:</strong> ${safeHost}<br>
        <strong>Environment:</strong> <span style="display:inline-block;padding:2px 8px;background:#fef3c7;color:#92400e;border-radius:4px;font-size:11px;font-weight:600;text-transform:uppercase">${safeEnv}</span><br>
        <strong>Invoker:</strong> ${safeInvoker}<br>
        <strong>Expires at:</strong> ${safeExpires}
      </td></tr>
    </table>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px;width:100%;background:#fafafa;border:1px solid #e4e4e7;border-radius:8px;">
      <tr><td style="padding:16px;font:400 13px/1.6 -apple-system,sans-serif;color:#3f3f46">
        <strong>Reason provided:</strong><br>
        <span style="display:block;margin-top:8px;padding:8px 12px;background:#f4f4f5;border-left:3px solid #dc2626;border-radius:4px;font-style:italic">${safeReason}</span>
      </td></tr>
    </table>
    <p style="margin:0 0 16px;font:400 13px/1.5 -apple-system,sans-serif;color:#71717a">
      If this access was not authorised or you suspect a security incident, revoke the
      access request immediately from the Shellius dashboard and investigate.
    </p>
    ${safeUrl ? `<div style="margin:32px 0;text-align:center"><a href="${safeUrl}" style="display:inline-block;padding:12px 24px;background:#dc2626;color:#fff;text-decoration:none;border-radius:6px;font:600 14px/1 -apple-system,sans-serif">View Audit Log</a></div>` : ''}
  `;

  const text = `ALERT: Break-glass access invoked — ${serverHostname}

${invokerName} has invoked emergency break-glass access.

Server: ${serverHostname} (${environment})
Invoker: ${invokerName}
Expires at: ${expiresAt}

Reason: ${reason}

${auditUrl ? `View audit log: ${auditUrl}` : ''}`;

  return {
    subject,
    html: renderLayout({ title: subject, preheader: `ALERT: ${invokerName} invoked break-glass on ${serverHostname}`, bodyHtml }),
    text,
  };
}
