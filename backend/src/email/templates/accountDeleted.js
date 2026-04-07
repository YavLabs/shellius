import { escapeHtml as esc } from '../escape.js';
import { renderLayout } from '../layout.js';

/**
 * accountDeleted email template.
 *
 * Vars:
 *   recipientName   {string}  - display name
 *   when            {string}  - ISO timestamp of deletion
 *   gracePeriodDays {number}  - days before hard purge (default 30)
 */
export function render({ recipientName, when, gracePeriodDays = 30 }) {
  const subject = '[Shellius] Your account has been deleted';
  const safeName = esc(recipientName || 'there');
  const safeWhen = esc(when || new Date().toISOString());
  const safeDays = Number(gracePeriodDays) || 30;

  const bodyHtml = `
    <h1 style="margin:0 0 16px;font:600 22px/1.3 -apple-system,sans-serif;color:#0a0a0a">
      Your account has been deleted
    </h1>
    <p style="margin:0 0 16px;font:400 15px/1.5 -apple-system,sans-serif;color:#3f3f46">
      Hi ${safeName}, this email confirms that your Shellius account was deleted.
    </p>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0;width:100%;background:#fafafa;border:1px solid #e4e4e7;border-radius:8px;">
      <tr><td style="padding:16px;font:400 13px/1.6 -apple-system,sans-serif;color:#3f3f46">
        <strong>Deleted at:</strong> ${safeWhen}<br>
        <strong>Grace period:</strong> ${safeDays} days before permanent removal
      </td></tr>
    </table>
    <p style="margin:0 0 16px;font:400 14px/1.5 -apple-system,sans-serif;color:#3f3f46">
      Your data will be permanently removed after the ${safeDays}-day grace period.
      If this was a mistake, please contact your administrator as soon as possible.
    </p>
    <p style="margin:0;font:400 13px/1.5 -apple-system,sans-serif;color:#71717a">
      If you did not request this deletion, contact your organization administrator immediately.
    </p>
  `;

  const text = `Your Shellius account has been deleted.

Deleted at: ${when}
Grace period: ${safeDays} days before permanent removal.

Your data will be permanently removed after the grace period.
If this was a mistake, contact your administrator immediately.`;

  return {
    subject,
    html: renderLayout({ title: subject, preheader: 'Your Shellius account has been deleted', bodyHtml }),
    text,
  };
}
