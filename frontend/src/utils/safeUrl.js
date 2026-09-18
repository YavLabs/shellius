/**
 * safeUrl.js
 *
 * Guards against unsafe URL schemes (javascript:, vbscript:, plain data:
 * HTML, etc.) being rendered into <img src>/href from user- or IdP-supplied
 * data (SSO profile pictures, uploaded avatar data URLs, imported records).
 */

// Raster/vector image MIME types we're willing to render as data: URLs.
// SVG is intentionally excluded — data:image/svg+xml can embed <script> /
// event-handler attributes that some renderers (not <img>, but anything
// that later treats the same string as markup) would execute.
const SAFE_DATA_IMAGE_PREFIX = /^data:image\/(png|jpe?g|gif|webp|x-icon|bmp);base64,/i;

/** True if `url` is safe to use as an <img src>: https: or a raster data:image/*. */
export function isSafeImageUrl(url) {
  if (typeof url !== 'string' || !url) return false;
  const trimmed = url.trim();
  if (/^https:\/\//i.test(trimmed)) return true;
  if (SAFE_DATA_IMAGE_PREFIX.test(trimmed)) return true;
  return false;
}

/** True if `url` is safe to use as an <a href>: http(s) only (no javascript:/data:/vbscript:). */
export function isSafeLinkUrl(url) {
  if (typeof url !== 'string' || !url) return false;
  return /^https?:\/\//i.test(url.trim());
}
