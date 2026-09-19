import { escapeHtml as esc } from '../escape.js';
import { renderLayout } from '../layout.js';
import { FONT_STACK } from '../brand.js';

/**
 * emailTest template — sent by Settings → Email → "Send test email" to
 * confirm an email provider delivers end to end and that the branded layout
 * renders in the recipient's client.
 *
 * Vars:
 *   recipientName {string} - display name (optional; the To may be any address)
 *   orgName       {string} - organization name
 *   providerName  {string} - the provider's name in Shellius (e.g. "Company Gmail")
 *   providerLabel {string} - provider type label (e.g. "Google (Gmail API)")
 *   fromAddress   {string} - sender address used
 *   when          {string} - ISO timestamp the test was sent
 */
export function render({ recipientName, orgName, providerName, providerLabel, fromAddress, when }) {
  const subject = '[Shellius] Test email';
  const sentAt = when || new Date().toISOString();
  const safeName = esc(recipientName || 'there');
  const safeOrg = esc(orgName || 'your organization');
  const safeProvider = esc(providerName || 'Email provider');
  const safeLabel = esc(providerLabel || '');
  const safeFrom = esc(fromAddress || '');
  const safeWhen = esc(sentAt);

  const row = (label, value) =>
    value
      ? `<tr>
          <td style="padding:6px 16px 6px 0;font:600 13px/1.5 ${FONT_STACK};color:#09090C;white-space:nowrap;vertical-align:top">${label}</td>
          <td style="padding:6px 0;font:400 13px/1.5 ${FONT_STACK};color:#3f3f46;word-break:break-all">${value}</td>
        </tr>`
      : '';

  const bodyHtml = `
    <h1 style="margin:0 0 16px;font:600 22px/1.3 ${FONT_STACK};color:#09090C">
      Email delivery is working
    </h1>
    <p style="margin:0 0 16px;font:400 15px/1.5 ${FONT_STACK};color:#3f3f46">
      Hi ${safeName}, this is a test message from Shellius confirming that
      email for <strong>${safeOrg}</strong> can be delivered through the
      provider below. If you are reading this in your inbox, you are good to go.
    </p>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0;width:100%;background:#fafafa;border:1px solid #e4e4e7;border-radius:8px;">
      <tr><td style="padding:12px 16px">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0">
          ${row('Provider', safeProvider)}
          ${row('Type', safeLabel)}
          ${row('From', safeFrom)}
          ${row('Sent at', safeWhen)}
        </table>
      </td></tr>
    </table>
    <p style="margin:0;font:400 13px/1.5 ${FONT_STACK};color:#71717a">
      No action is required. You can safely delete this message.
    </p>
  `;

  const lines = [
    'Email delivery is working',
    '',
    `Hi ${recipientName || 'there'}, this is a test message from Shellius confirming that`,
    `email for ${orgName || 'your organization'} can be delivered through the provider below.`,
    '',
    `Provider: ${providerName || 'Email provider'}`,
    providerLabel ? `Type:     ${providerLabel}` : null,
    fromAddress ? `From:     ${fromAddress}` : null,
    `Sent at:  ${sentAt}`,
    '',
    'No action is required. You can safely delete this message.',
  ].filter((l) => l !== null);

  return {
    subject,
    html: renderLayout({ title: subject, preheader: `Test email sent via ${providerName || 'your email provider'}`, bodyHtml }),
    text: lines.join('\n'),
  };
}
