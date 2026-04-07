/**
 * layout.js
 *
 * Shared HTML email layout. Inline styles only — every modern mail
 * client (Gmail, Outlook, Apple Mail, mobile) strips <link> and most
 * <style> tags, so we hand-write the styles inline. Max-width 600px
 * is the de-facto email standard. The dark header + emerald accent
 * matches the Shellius web UI theme.
 *
 * No external dependencies — just template literals.
 */

import { escapeHtml as esc } from './escape.js';

/**
 * Render a complete HTML email document.
 *
 * @param {object} params
 * @param {string} params.title       - <title> tag content (also fallback for preheader)
 * @param {string} [params.preheader] - hidden preview text shown in inbox
 * @param {string} params.bodyHtml    - the rendered template body (already-escaped)
 * @param {string} [params.footerHtml]- optional override for the footer block
 * @returns {string}
 */
export function renderLayout({ title, preheader, bodyHtml, footerHtml }) {
  const safeTitle = esc(title);
  const safePreheader = esc(preheader || title);
  const safeFooter =
    footerHtml ||
    `
      <p style="margin:0 0 8px;font:400 12px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#999;text-align:center">
        Sent by Shellius — Centralized SSH/RDP Access Management
      </p>
      <p style="margin:0;font:400 11px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#bbb;text-align:center">
        You received this email because of activity on your Shellius account.
        If you did not expect it, contact your administrator.
      </p>
    `;

  return `<!doctype html>
<html lang="en" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta http-equiv="X-UA-Compatible" content="IE=edge">
    <meta name="x-apple-disable-message-reformatting">
    <title>${safeTitle}</title>
    <!--[if mso]>
    <style>
      * { font-family: Arial, sans-serif !important; }
    </style>
    <![endif]-->
  </head>
  <body style="margin:0;padding:0;background:#f4f4f5;">
    <!-- preheader (hidden inbox preview text) -->
    <div style="display:none !important;visibility:hidden;mso-hide:all;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">
      ${safePreheader}
    </div>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f4f5;">
      <tr>
        <td align="center" style="padding:24px 12px;">

          <!-- Outer container -->
          <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"
                 style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.04);">

            <!-- Header (dark) -->
            <tr>
              <td style="background:#0a0a0a;padding:24px 32px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td style="vertical-align:middle;">
                      <span style="display:inline-block;font:700 22px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#ffffff;letter-spacing:-0.02em;">
                        <span style="color:#10b981;">&gt;_</span> Shellius
                      </span>
                    </td>
                    <td align="right" style="vertical-align:middle;">
                      <span style="font:500 12px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#a1a1aa;text-transform:uppercase;letter-spacing:0.05em;">
                        SSH/RDP Access
                      </span>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <!-- Body -->
            <tr>
              <td style="padding:32px;background:#ffffff;">
                ${bodyHtml}
              </td>
            </tr>

            <!-- Footer -->
            <tr>
              <td style="padding:24px 32px;background:#fafafa;border-top:1px solid #e4e4e7;">
                ${safeFooter}
              </td>
            </tr>
          </table>

        </td>
      </tr>
    </table>
  </body>
</html>`;
}
