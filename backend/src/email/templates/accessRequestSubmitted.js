import { escapeHtml as esc } from '../escape.js';
import { renderLayout } from '../layout.js';
import { button } from '../button.js';

export function render({ reviewerName, requesterName, serverHostname, environment, reason, reviewUrl }) {
  const subject = `[Shellius] Access request: ${requesterName} → ${serverHostname}`;
  const safeReviewer = esc(reviewerName || 'there');
  const safeRequester = esc(requesterName || 'A user');
  const safeHost = esc(serverHostname);
  const safeEnv = esc(environment || 'unknown');
  const safeReason = esc(reason || '(no reason provided)');
  const safeUrl = esc(reviewUrl);

  const bodyHtml = `
    <h1 style="margin:0 0 16px;font:600 22px/1.3 -apple-system,sans-serif;color:#0a0a0a">
      New access request awaiting review
    </h1>
    <p style="margin:0 0 16px;font:400 15px/1.5 -apple-system,sans-serif;color:#3f3f46">
      Hi ${safeReviewer}, ${safeRequester} has requested access to a server
      that requires your approval.
    </p>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0;width:100%;background:#fafafa;border:1px solid #e4e4e7;border-radius:8px;">
      <tr><td style="padding:16px;font:400 13px/1.6 -apple-system,sans-serif;color:#3f3f46">
        <strong>Server:</strong> ${safeHost}<br>
        <strong>Environment:</strong> <span style="display:inline-block;padding:2px 8px;background:#fef3c7;color:#92400e;border-radius:4px;font-size:11px;font-weight:600;text-transform:uppercase">${safeEnv}</span><br>
        <strong>Reason:</strong> ${safeReason}
      </td></tr>
    </table>
    <div style="margin:32px 0;text-align:center">
      ${button({ href: safeUrl, label: 'Review Request' })}
    </div>
  `;

  const text = `New access request awaiting review.

${requesterName} requested access to ${serverHostname} (${environment}).

Reason: ${reason}

Review at: ${reviewUrl}`;

  return {
    subject,
    html: renderLayout({ title: subject, preheader: `${requesterName} → ${serverHostname}`, bodyHtml }),
    text,
  };
}
