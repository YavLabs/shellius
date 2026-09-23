import api from './api';

/**
 * Chat notification destinations (Administration → Chat notifications,
 * permission settings.notifications).
 *
 * Same shape as the audit sinks: secrets are write-only, responses carry
 * `{ set: boolean }` in their place, and omitting a secret on update keeps
 * the stored value. See services/auditSinkService.js.
 */

const data = (r) => r.data?.data;

/** GET /settings/chat/platforms → [{ platform, label, secretFields, supportsButtons, supportsDirectMessages }] */
export const listChatPlatforms = () => api.get('/settings/chat/platforms').then((r) => data(r) ?? []);

/** GET /settings/chat/events → [{ key, label, description, severity, chatDefault }] */
export const listChatEvents = () => api.get('/settings/chat/events').then((r) => data(r) ?? []);

/** GET /settings/chat/destinations → Destination[] */
export const listChatDestinations = () => api.get('/settings/chat/destinations').then((r) => data(r) ?? []);

/** POST /settings/chat/destinations { platform, mode?, config, name?, isActive?, events?, environments?, customerIds?, minSeverity? } → Destination */
export const createChatDestination = (body) => api.post('/settings/chat/destinations', body).then((r) => data(r));

/** PUT /settings/chat/destinations/:id { name?, mode?, config?, isActive?, events?, environments?, customerIds?, minSeverity? } → Destination */
export const updateChatDestination = (id, body) => api.put(`/settings/chat/destinations/${id}`, body).then((r) => data(r));

/** DELETE /settings/chat/destinations/:id */
export const deleteChatDestination = (id) => api.delete(`/settings/chat/destinations/${id}`).then((r) => data(r));

/** POST /settings/chat/destinations/:id/test → { ok, detail? } | { ok: false, error } — a failed test is ok:false, not an HTTP error. */
export const testChatDestination = (id) => api.post(`/settings/chat/destinations/${id}/test`).then((r) => data(r));

/** GET /settings/chat/destinations/:id/deliveries?limit= → Delivery[] */
export const listChatDeliveries = (id, limit = 20) =>
  api.get(`/settings/chat/destinations/${id}/deliveries`, { params: { limit } }).then((r) => data(r) ?? []);
