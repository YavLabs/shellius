import api from './api';

/**
 * updateService.js — client for routes/updates.js.
 *
 * Nothing here installs anything. `requestSelfUpdate` records an INTENT that
 * a host-side helper — which an operator installed deliberately — picks up and
 * acts on; see docs/instance-updates.md for why the application has no
 * capability to upgrade itself. `getUpdateStatus` is cheap to call on
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

// --- self-update -------------------------------------------------------------
//
// `getSelfUpdate` reports whether a helper exists at all. With no helper, the
// UI shows the command to run by hand — which is the default, and a fine end
// state. Requesting an upgrade when nothing is listening would just queue a
// row nobody reads, so the button is only offered when a helper is present.

export const getSelfUpdate = () => api.get('/updates/self').then((r) => r.data?.data ?? r.data);

export const requestSelfUpdate = (version) =>
  api.post('/updates/self/request', { version }).then((r) => r.data?.data ?? r.data);

export const cancelSelfUpdate = (id) =>
  api.delete(`/updates/self/request/${id}`).then((r) => r.data?.data ?? r.data);
