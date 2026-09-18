/**
 * avatar.js — strict validation/decoding for user-uploaded avatar data URLs.
 *
 * PUT /api/users/me/avatar accepts `{ dataUrl }` — a base64 data URL for a
 * png/jpeg/webp image, at most 150KB once decoded (the UI resizes to 128x128
 * WebP before upload; this is a server-side backstop, not the primary
 * resize step). Magic bytes are checked against the declared MIME type so a
 * mislabeled or malicious payload can't slip through.
 */

import ApiError from './ApiError.js';

export const MAX_AVATAR_BYTES = 150 * 1024;

const DATA_URL_RE = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/;

/**
 * @param {Buffer} buffer
 * @param {string} mime
 * @returns {boolean}
 */
function magicBytesMatch(buffer, mime) {
  if (mime === 'image/png') {
    const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    return buffer.length >= sig.length && sig.every((b, i) => buffer[i] === b);
  }
  if (mime === 'image/jpeg') {
    return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  }
  if (mime === 'image/webp') {
    return (
      buffer.length >= 12 &&
      buffer.toString('ascii', 0, 4) === 'RIFF' &&
      buffer.toString('ascii', 8, 12) === 'WEBP'
    );
  }
  return false;
}

/**
 * Parse + strictly validate a `data:image/(png|jpeg|webp);base64,...` URL.
 * Throws ApiError(400) on any malformed/oversized/mismatched input.
 *
 * @param {string} dataUrl
 * @returns {{ mime: string, buffer: Buffer, dataUrl: string }} - `dataUrl` is
 *   re-serialized from the decoded buffer (strips any trailing garbage).
 */
export function parseAvatarDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string' || !dataUrl.trim()) {
    throw new ApiError(400, 'dataUrl is required');
  }

  const match = DATA_URL_RE.exec(dataUrl.trim());
  if (!match) {
    throw new ApiError(400, 'dataUrl must be a base64 data URL of type image/png, image/jpeg, or image/webp');
  }
  const [, mime, b64] = match;

  let buffer;
  try {
    buffer = Buffer.from(b64, 'base64');
  } catch {
    throw new ApiError(400, 'dataUrl is not valid base64');
  }

  // Buffer.from(..., 'base64') silently ignores invalid characters instead of
  // throwing — round-trip the decode to catch truncated/corrupt base64.
  if (buffer.length === 0 || Buffer.from(buffer.toString('base64'), 'base64').length !== buffer.length) {
    throw new ApiError(400, 'dataUrl is not valid base64');
  }

  if (buffer.length > MAX_AVATAR_BYTES) {
    throw new ApiError(400, `Avatar image must be ${Math.floor(MAX_AVATAR_BYTES / 1024)}KB or smaller once decoded`);
  }

  if (!magicBytesMatch(buffer, mime)) {
    throw new ApiError(400, 'dataUrl content does not match its declared image type');
  }

  return { mime, buffer, dataUrl: `data:${mime};base64,${buffer.toString('base64')}` };
}

export default { parseAvatarDataUrl, MAX_AVATAR_BYTES };
