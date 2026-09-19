/**
 * layout.js
 *
 * Shared HTML email layout. Table-based with inline styles only — Gmail,
 * Outlook, Apple Mail and mobile clients strip <link> and most <style> tags.
 * Max-width 600px is the de-facto email standard.
 *
 * Header: the Shellius lockup (hosted PNG, see brand.js) on the Ink → Indigo
 * brand background, with a Sky → Lavender accent rule. Gradients are
 * progressive enhancement: every gradient cell also has a solid bgcolor for
 * clients (Outlook desktop) that ignore background-image.
 *
 * No external dependencies — just template literals.
 */

import { escapeHtml as esc } from './escape.js';
import { BRAND, FONT_STACK } from './brand.js';

/**
 * Header logo: the full Shellius lockup (icon chip + wordmark) built from
 * HTML tables — no image, so it shows even where remote images are blocked
 * (Outlook, Gmail for new senders) and when the app has no public URL.
 * Mirrors the app's BrandLogo: a rounded Sky→Lavender chip with ">_", then
 * SHELL, a cap-height gradient bar and US with tight tracking. Clients
 * without CSS gradients get the solid bgcolor (Sky).
 */
export function renderLogo() {
  const chip = `<td width="32" height="32" align="center" valign="middle" bgcolor="${BRAND.sky}"
                            style="width:32px;height:32px;background:${BRAND.sky};background-image:linear-gradient(135deg,${BRAND.sky} 0%,${BRAND.lavender} 100%);border-radius:9px;font:800 17px/32px Menlo,Consolas,'Courier New',monospace;color:${BRAND.ink};letter-spacing:-0.08em;text-align:center;">&gt;_</td>`;
  // SHELL, the bar and US share one text line: the bar is an inline-block
  // sitting on the baseline at cap height (0.7em), like the app's wordmark,
  // so it lines up with the letters in every client's font. Outlook's Word
  // renderer ignores inline-block sizes, so it gets a Sky block glyph instead.
  // The margins are uneven on purpose: in the system fonts mail clients use,
  // a bold L has almost no right side-bearing while U has a wide left one,
  // so equal margins leave a visibly bigger gap before U.
  const bar = `<!--[if mso]><span style="color:${BRAND.sky};">&#9646;</span><![endif]--><!--[if !mso]><!--><span style="display:inline-block;width:0.34em;height:0.7em;margin:0 0.01em 0 0.14em;vertical-align:baseline;background:${BRAND.sky};background-image:linear-gradient(135deg,${BRAND.sky} 0%,${BRAND.lavender} 100%);border-radius:1px;"></span><!--<![endif]-->`;
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" aria-label="Shellius">
                        <tr>
                          <td style="padding:0 10px 0 0;vertical-align:middle;">
                            <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
                              ${chip}
                            </tr></table>
                          </td>
                          <td style="font:800 21px/1 ${FONT_STACK};color:${BRAND.light};letter-spacing:-0.02em;vertical-align:middle;white-space:nowrap;">SHELL${bar}US</td>
                        </tr>
                      </table>`;
}

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
      <p style="margin:0 0 8px;font:400 12px/1.5 ${FONT_STACK};color:${BRAND.muted};text-align:center">
        Sent by Shellius — Centralized SSH/RDP Access Management
      </p>
      <p style="margin:0;font:400 11px/1.5 ${FONT_STACK};color:#a1a1aa;text-align:center">
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
    <meta name="color-scheme" content="light">
    <meta name="supported-color-schemes" content="light">
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

            <!-- Header (Ink → Indigo) -->
            <tr>
              <td bgcolor="${BRAND.ink}" style="background:${BRAND.ink};background-image:linear-gradient(135deg,${BRAND.ink} 0%,${BRAND.indigo} 100%);padding:26px 32px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td style="vertical-align:middle;">
                      ${renderLogo()}
                    </td>
                    <td align="right" style="vertical-align:middle;">
                      <span style="font:500 11px/1 ${FONT_STACK};color:${BRAND.muted};text-transform:uppercase;letter-spacing:0.12em;">
                        SSH / RDP Access
                      </span>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <!-- Accent rule (Sky → Lavender) -->
            <tr>
              <td height="3" bgcolor="${BRAND.sky}" style="height:3px;background:${BRAND.sky};background-image:linear-gradient(90deg,${BRAND.sky} 0%,${BRAND.lavender} 100%);font-size:0;line-height:0;">&nbsp;</td>
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
