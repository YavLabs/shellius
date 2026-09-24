import api from './api';

/**
 * updateService.js — client for routes/updates.js.
 *
 * Read-only by design on the API side (see the route file's own comment):
 * nothing here can trigger an install. `getUpdateStatus` is cheap to call on
 * mount (the backend caches ~6h); `checkForUpdates` bypasses that cache for
 * the "Check now" button and is rate limited server-side to 5/15min — a 429
 * comes back as the usual `{ success:false, error:{ code:'RATE_LIMITED' } }`
 * envelope, so callers can show the server's own message instead of a
 * generic failure.
 */

export const getUpdateStatus = () => api.get('/updates').then((r) => r.data?.data ?? r.data);

export const checkForUpdates = () => api.post('/updates/check').then((r) => r.data?.data ?? r.data);

export const getCollectorVersions = () =>
  api.get('/updates/collectors').then((r) => r.data?.data ?? r.data);
