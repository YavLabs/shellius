/**
 * button.js
 *
 * Renders a CTA button for HTML emails as an inline-styled anchor, plus a
 * VML roundrect for Outlook desktop. The href must already be HTML-escaped
 * by the caller.
 *
 * Default (brand) button: Sky → Lavender gradient with Ink text. Clients
 * without CSS gradients (Outlook) get the solid Sky fill. Passing `color`
 * renders a solid button with white text instead (e.g. a red "Reject").
 */

import { BRAND, FONT_STACK } from './brand.js';

/**
 * @param {object} params
 * @param {string} params.href    - URL (HTML-escaped)
 * @param {string} params.label   - Button label text
 * @param {string} [params.color] - solid fill hex; omit for the brand gradient
 * @returns {string} HTML string
 */
export function button({ href, label, color }) {
  const fill = color || BRAND.sky;
  const textColor = color ? '#ffffff' : BRAND.ink;
  const gradient = color ? '' : `background-image:linear-gradient(135deg,${BRAND.sky} 0%,${BRAND.lavender} 100%);`;
  return `
<!--[if mso]>
<v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word"
  href="${href}"
  style="height:48px;v-text-anchor:middle;width:220px;"
  arcsize="20%"
  stroke="f"
  fillcolor="${fill}">
  <w:anchorlock/>
  <center style="color:${textColor};font-family:Arial,sans-serif;font-size:15px;font-weight:bold;">${label}</center>
</v:roundrect>
<![endif]-->
<!--[if !mso]><!-->
<a href="${href}"
   target="_blank"
   rel="noopener"
   style="
     display:inline-block;
     background:${fill};
     ${gradient}
     color:${textColor};
     font-family:${FONT_STACK};
     font-size:15px;
     font-weight:600;
     line-height:1;
     text-decoration:none;
     padding:14px 28px;
     border-radius:8px;
     mso-hide:all;
   ">${label}</a>
<!--<![endif]-->
`.trim();
}
