/**
 * button.js
 *
 * Renders a primary CTA button for HTML emails.
 * Returns an inline-styled anchor element that renders consistently across
 * major email clients. The href must already be HTML-escaped by the caller.
 */

/**
 * @param {object} params
 * @param {string} params.href  - URL (HTML-escaped)
 * @param {string} params.label - Button label text
 * @returns {string} HTML string
 */
export function button({ href, label }) {
  return `
<!--[if mso]>
<v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word"
  href="${href}"
  style="height:48px;v-text-anchor:middle;width:200px;"
  arcsize="25%"
  stroke="f"
  fillcolor="#10b981">
  <w:anchorlock/>
  <center style="color:#ffffff;font-family:-apple-system,sans-serif;font-size:15px;font-weight:600;">${label}</center>
</v:roundrect>
<![endif]-->
<!--[if !mso]><!-->
<a href="${href}"
   target="_blank"
   rel="noopener"
   style="
     display:inline-block;
     background:#10b981;
     color:#ffffff;
     font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
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
