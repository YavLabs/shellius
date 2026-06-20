import { escapeHtml as esc } from '../escape.js';
import { renderLayout } from '../layout.js';
import { button } from '../button.js';

/**
 * One-click access-request approval email. The CTAs link to a no-login
 * confirmation page (carrying a single-use token) where the approver clicks
 * Approve / Reject — the actual decision is a POST, so email link-prefetchers
 * cannot accidentally action the request.
 */
export function render({
  approverName,
  requesterName,
  serverHostname,
  environment,
  reason,
  durationLabel,
  approveUrl,
  rejectUrl,
}) {
  const subject = `[Shellius] Approval needed: ${requesterName} → ${serverHostname}`;
  const safeApprover = esc(approverName || 'there');
  const safeRequester = esc(requesterName || 'A user');
  const safeHost = esc(serverHostname);
  const safeEnv = esc(environment || 'unknown');
  const safeReason = esc(reason || '(no reason provided)');
  const safeDuration = esc(durationLabel || '');
  const safeApprove = esc(approveUrl);
  const safeReject = esc(rejectUrl);

  const bodyHtml = `
    <h1 style="margin:0 0 16px;font:600 22px/1.3 -apple-system,sans-serif;color:#0a0a0a">
      Access request needs your approval
    </h1>
    <p style="margin:0 0 16px;font:400 15px/1.5 -apple-system,sans-serif;color:#3f3f46">
      Hi ${safeApprover}, ${safeRequester} is requesting access to a server that requires
      your approval. You can approve or reject right here — no need to sign in.
    </p>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0;width:100%;background:#fafafa;border:1px solid #e4e4e7;border-radius:8px;">
      <tr><td style="padding:16px;font:400 13px/1.6 -apple-system,sans-serif;color:#3f3f46">
        <strong>Server:</strong> ${safeHost}<br>
        <strong>Environment:</strong> <span style="display:inline-block;padding:2px 8px;background:#fef3c7;color:#92400e;border-radius:4px;font-size:11px;font-weight:600;text-transform:uppercase">${safeEnv}</span><br>
        ${safeDuration ? `<strong>Requested for:</strong> ${safeDuration}<br>` : ''}
        <strong>Reason:</strong> ${safeReason}
      </td></tr>
    </table>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:32px auto;">
      <tr>
        <td style="padding:0 8px">${button({ href: safeApprove, label: 'Approve' })}</td>
        <td style="padding:0 8px">${button({ href: safeReject, label: 'Reject', color: '#dc2626' })}</td>
      </tr>
    </table>
    <p style="margin:16px 0 0;font:400 12px/1.5 -apple-system,sans-serif;color:#a1a1aa;text-align:center">
      This link is single-use and expires in 24 hours. Both buttons open a confirmation page first.
    </p>
  `;

  const text = `Access request needs your approval.

${requesterName} requested access to ${serverHostname} (${environment}).
${durationLabel ? `Requested for: ${durationLabel}\n` : ''}Reason: ${reason}

Approve: ${approveUrl}
Reject:  ${rejectUrl}

This link is single-use and expires in 24 hours.`;

  return {
    subject,
    html: renderLayout({
      title: subject,
      preheader: `${requesterName} → ${serverHostname} needs approval`,
      bodyHtml,
    }),
    text,
  };
}
