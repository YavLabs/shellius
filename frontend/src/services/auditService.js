import api from './api';

/**
 * List audit log entries with optional filters and pagination.
 * Returns { success, data: { items }, meta: { page, limit, total } }
 */
export const listAudit = (params) =>
  api.get('/audit', { params }).then((r) => r.data);

/**
 * Export audit log entries as CSV or JSON.
 * Triggers a browser download via a temporary anchor element.
 *
 * @param {'csv'|'json'} format
 * @param {object} params  - same filter params as listAudit (excluding page/limit)
 */
export const exportAudit = async (format, params = {}) => {
  const token = localStorage.getItem('accessToken');
  const base = import.meta.env.VITE_API_URL || '/api';

  const query = new URLSearchParams({ format, ...params });
  const url = `${base}/audit/export?${query.toString()}`;

  const response = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body?.error?.message || `Export failed: ${response.status}`);
  }

  // Extract filename from Content-Disposition or fall back to a default
  const disposition = response.headers.get('Content-Disposition') || '';
  const match = disposition.match(/filename="?([^";\s]+)"?/);
  const filename = match ? match[1] : `audit-export.${format}`;

  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);

  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(objectUrl);
};
