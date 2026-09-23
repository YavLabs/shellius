import api from './api';

/**
 * Audit sinks (Administration → Audit sinks, permission audit.sinks).
 * Secrets are write-only: responses carry `{ set: boolean }` in their place,
 * and omitting a secret on update keeps the stored value — exactly like the
 * email providers (services/emailProviderService.js).
 */

const data = (r) => r.data?.data;

/** GET /settings/audit-sinks → Sink[] */
export const listAuditSinks = () => api.get('/settings/audit-sinks').then((r) => data(r) ?? []);

/** GET /settings/audit-sinks/types → [{ type, label, streaming, secretFields }] */
export const getSinkTypes = () => api.get('/settings/audit-sinks/types').then((r) => data(r) ?? []);

/** GET /settings/audit-sinks/:id → Sink */
export const getAuditSink = (id) => api.get(`/settings/audit-sinks/${id}`).then((r) => data(r));

/** POST /settings/audit-sinks { name, type, config, filters?, isActive?, batchSize?, backfillFrom? } → Sink */
export const createAuditSink = (body) => api.post('/settings/audit-sinks', body).then((r) => data(r));

/** PUT /settings/audit-sinks/:id { name?, config?, filters?, isActive?, batchSize? } → Sink */
export const updateAuditSink = (id, body) => api.put(`/settings/audit-sinks/${id}`, body).then((r) => data(r));

/** DELETE /settings/audit-sinks/:id */
export const deleteAuditSink = (id) => api.delete(`/settings/audit-sinks/${id}`).then((r) => data(r));

/** POST /settings/audit-sinks/:id/test → { ok, detail?, error? } — a failed test is ok:false, not an HTTP error. */
export const testAuditSink = (id) => api.post(`/settings/audit-sinks/${id}/test`).then((r) => data(r));

/** GET /settings/audit-sinks/:id/deliveries?limit= → Delivery[] */
export const listAuditSinkDeliveries = (id, limit = 20) =>
  api.get(`/settings/audit-sinks/${id}/deliveries`, { params: { limit } }).then((r) => data(r) ?? []);
