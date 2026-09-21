/**
 * Downloading a response the browser must save rather than render.
 *
 * Axios is not used here on purpose: these responses are binary (zip, pdf)
 * and carry the filename in Content-Disposition, which the shared client's
 * JSON envelope unwrapping would get in the way of. The anchor-and-blob
 * dance was open-coded in a dozen places before this existed.
 */

const API_BASE = () => import.meta.env.VITE_API_URL || '/api';

function filenameFrom(response, fallback) {
  const disposition = response.headers.get('Content-Disposition') || '';
  // RFC 5987 form first (filename*=UTF-8''...), then the plain one.
  const encoded = disposition.match(/filename\*=UTF-8''([^;\s]+)/i);
  if (encoded) {
    try {
      return decodeURIComponent(encoded[1]);
    } catch {
      /* fall through to the plain form */
    }
  }
  const plain = disposition.match(/filename="?([^";]+)"?/i);
  return plain ? plain[1].trim() : fallback;
}

/** Save a Blob under `filename`, cleaning up the object URL afterwards. */
export function saveBlob(blob, filename) {
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  // Revoking synchronously can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}

/**
 * POST a JSON body and save the file that comes back.
 *
 * @param {string} path      API path, e.g. '/posture/export'
 * @param {object} body
 * @param {string} fallbackName used when the server sends no Content-Disposition
 * @returns {Promise<{filename: string, rows: number|null, servers: number|null}>}
 *   The counts come from X-Export-* headers so the caller can say what was
 *   actually exported — an empty file is a result worth reporting, not a
 *   silent no-op.
 */
export async function downloadPost(path, body, fallbackName = 'download') {
  const token = localStorage.getItem('accessToken');
  const response = await fetch(`${API_BASE()}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    // The error path is JSON even though the success path is not.
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload?.error?.message || `Export failed (${response.status})`);
  }

  const filename = filenameFrom(response, fallbackName);
  const num = (h) => {
    const v = response.headers.get(h);
    return v === null ? null : Number(v);
  };
  const meta = { filename, rows: num('X-Export-Rows'), servers: num('X-Export-Servers') };

  saveBlob(await response.blob(), filename);
  return meta;
}

export default { downloadPost, saveBlob };
