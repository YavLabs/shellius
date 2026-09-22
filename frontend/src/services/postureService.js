import api from './api';
import { downloadPost } from '@/utils/download';

/**
 * Posture — exposure findings, per-server snapshots and org settings/alert
 * rules. Matches the contract in docs/posture/posture-spec.md §8; the
 * backend is built against the same contract.
 */

// ---------------------------------------------------------------------------
// Fleet summary + findings inbox
// ---------------------------------------------------------------------------

/** `params.customerId` narrows the summary to one customer. */
export const getPostureSummary = (params) =>
  api.get('/posture/summary', { params }).then((r) => r.data?.data ?? r.data);

export const listFindings = (params) =>
  api.get('/posture/findings', { params }).then((r) => r.data?.data ?? r.data);

/**
 * The findings list's group tree over the whole filtered set:
 * `params` = the list's own filters (section/status included) + `groupBy`
 * ('severity,server'). Returns `{ groupBy, tree }`.
 */
export const getFindingGroups = (params) =>
  api.get('/posture/findings/groups', { params }).then((r) => r.data?.data ?? r.data);

export const getServerPosture = (serverId) =>
  api.get(`/posture/servers/${serverId}`).then((r) => r.data?.data ?? r.data);

/**
 * Resource history for the drill-down page.
 * `params`: { from?: ISO, to?: ISO, bucket?: 'auto'|'raw'|'5m'|'15m'|'1h'|'6h'|'1d' }
 */
export const getServerMetrics = (serverId, params) =>
  api.get(`/posture/servers/${serverId}/metrics`, { params }).then((r) => r.data?.data ?? r.data);

// ---------------------------------------------------------------------------
// Finding actions
// ---------------------------------------------------------------------------

/** `{ days?, until?, reason }` — one of days/until is required by the API. */
export const muteFinding = (id, body) =>
  api.post(`/posture/findings/${id}/mute`, body).then((r) => r.data?.data ?? r.data);

export const unmuteFinding = (id) =>
  api.post(`/posture/findings/${id}/unmute`).then((r) => r.data?.data ?? r.data);

export const acknowledgeFinding = (id) =>
  api.post(`/posture/findings/${id}/acknowledge`).then((r) => r.data?.data ?? r.data);

// ---------------------------------------------------------------------------
// Per-server expected-public ports
// ---------------------------------------------------------------------------

export const listExpectedPorts = (serverId) =>
  api.get(`/posture/servers/${serverId}/expected-ports`).then((r) => r.data?.data?.items ?? []);

/** `entries`: [{ port, proto?, note }] — note is required by the API. */
export const addExpectedPorts = (serverId, entries) =>
  api.post(`/posture/servers/${serverId}/expected-ports`, { entries }).then((r) => r.data?.data ?? r.data);

export const removeExpectedPort = (serverId, entryId) =>
  api.delete(`/posture/servers/${serverId}/expected-ports/${entryId}`).then((r) => r.data?.data ?? r.data);

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const getExportFields = () =>
  api.get('/posture/export/fields').then((r) => r.data?.data ?? r.data);

/**
 * Builds the file server-side and saves it.
 * `{ dataset, format, bundle, fields, filters }` — see the API's exportSchema.
 */
export const exportPosture = (body) =>
  downloadPost('/posture/export', body, `shellius-${body.dataset}.${body.format}`);

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export const getPostureSettings = () =>
  api.get('/posture/settings').then((r) => r.data?.data ?? r.data);

export const updatePostureSettings = (body) =>
  api.put('/posture/settings', body).then((r) => r.data?.data ?? r.data);

// ---------------------------------------------------------------------------
// Alert rules
// ---------------------------------------------------------------------------

export const listAlertRules = () =>
  api.get('/posture/alert-rules').then((r) => r.data?.data?.rules ?? r.data?.data ?? r.data);

export const createAlertRule = (body) =>
  api.post('/posture/alert-rules', body).then((r) => r.data?.data ?? r.data);

export const updateAlertRule = (id, body) =>
  api.put(`/posture/alert-rules/${id}`, body).then((r) => r.data?.data ?? r.data);

export const deleteAlertRule = (id) =>
  api.delete(`/posture/alert-rules/${id}`).then((r) => r.data?.data ?? r.data);

/**
 * Collector coverage: which servers report, which are stale, which never
 * installed the collector. Powers the actionable list behind the Posture
 * page's "reporting X of Y" tile.
 */
export const getPostureServers = (params = {}) =>
  api.get('/posture/servers', { params }).then((r) => r.data?.data ?? r.data);

// ---------------------------------------------------------------------------
// Service inventory — what is running across the fleet (not what is wrong)
// ---------------------------------------------------------------------------

export const listInventoryServices = (params) =>
  api.get('/posture/inventory/services', { params }).then((r) => r.data?.data ?? r.data);

export const listInventoryListeners = (params) =>
  api.get('/posture/inventory/listeners', { params }).then((r) => r.data?.data ?? r.data);

export const getInventoryFacets = () =>
  api.get('/posture/inventory/facets').then((r) => r.data?.data ?? r.data);
