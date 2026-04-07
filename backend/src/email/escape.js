/**
 * escape.js
 *
 * Minimal HTML escape helper. No npm dependencies.
 * Used by email templates to prevent XSS via user-supplied strings.
 */

export function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
