import api from './api';

/**
 * Directory sync (Settings → Single sign-on → Directory sync, permission
 * settings.sso). Periodically checks each SSO provider's own user directory
 * (Entra, Okta, Google Workspace, GitHub org) and flags — or, once armed,
 * suspends — Shellius accounts whose person has left or been disabled there.
 * This is the only feature that can disable an account without a human
 * deciding to, so the UI around it (directorySync/) leans hard on making the
 * current state legible: dry run vs armed, aborted vs failed, and what a
 * run actually found.
 *
 * One entry exists per sign-in provider the org has configured, whether or
 * not sync has been set up for it yet — `sync` is null until it has.
 * Secrets in `sync.config` are write-only: the API returns `{ set: boolean }`
 * in their place, and omitting a secret on update keeps the stored value —
 * exactly like audit sinks (services/auditSinkService.js).
 */

const data = (r) => r.data?.data;

/** GET /settings/directory-sync/adapters → [{ type, label, secretFields, reportsDisabled }] */
export const listDirectorySyncAdapters = () =>
  api.get('/settings/directory-sync/adapters').then((r) => data(r) ?? []);

/** GET /settings/directory-sync → one entry per SSO provider (see file header) */
export const listDirectorySync = () => api.get('/settings/directory-sync').then((r) => data(r) ?? []);

/** POST /settings/directory-sync { ssoConfigId, config, ...settings } → sync */
export const createDirectorySync = (body) => api.post('/settings/directory-sync', body).then((r) => data(r));

/** PUT /settings/directory-sync/:id { config?, ...settings } → sync */
export const updateDirectorySync = (id, body) => api.put(`/settings/directory-sync/${id}`, body).then((r) => data(r));

/** DELETE /settings/directory-sync/:id */
export const deleteDirectorySync = (id) => api.delete(`/settings/directory-sync/${id}`).then((r) => data(r));

/** POST /settings/directory-sync/:id/test → { ok, detail? | error? } — a failed test is ok:false, not an HTTP error. */
export const testDirectorySync = (id) => api.post(`/settings/directory-sync/${id}/test`).then((r) => data(r));

/** POST /settings/directory-sync/:id/run → runs immediately, returns the run row */
export const runDirectorySync = (id) => api.post(`/settings/directory-sync/${id}/run`).then((r) => data(r));

/** GET /settings/directory-sync/:id/runs?limit= → Run[] */
export const listDirectorySyncRuns = (id, limit = 20) =>
  api.get(`/settings/directory-sync/${id}/runs`, { params: { limit } }).then((r) => data(r) ?? []);

/** GET /settings/directory-sync/:id/findings?status=open|all&limit= → Finding[] */
export const listDirectorySyncFindings = (id, { status = 'open', limit = 50 } = {}) =>
  api.get(`/settings/directory-sync/${id}/findings`, { params: { status, limit } }).then((r) => data(r) ?? []);
