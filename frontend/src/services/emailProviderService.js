import api from './api';

/**
 * Email providers (Settings → Email). Secrets are write-only: responses
 * carry `{ set: boolean }` in their place, and omitting a secret on update
 * keeps the stored value.
 */

export const listEmailProviders = () =>
  api.get('/settings/email/providers').then((r) => ({
    providers: r.data?.data?.providers ?? [],
    meta: r.data?.meta ?? {},
  }));

export const createEmailProvider = (body) =>
  api.post('/settings/email/providers', body).then((r) => r.data?.data?.provider);

export const updateEmailProvider = (id, body) =>
  api.put(`/settings/email/providers/${id}`, body).then((r) => r.data?.data?.provider);

export const deleteEmailProvider = (id) =>
  api.delete(`/settings/email/providers/${id}`).then((r) => r.data?.data);

export const activateEmailProvider = (id) =>
  api.post(`/settings/email/providers/${id}/activate`).then((r) => r.data?.data?.provider);

export const deactivateEmailProvider = (id) =>
  api.post(`/settings/email/providers/${id}/deactivate`).then((r) => r.data?.data?.provider);

/** → { ok, sentTo, error, provider } — a failed delivery is ok:false, not an HTTP error. */
export const testEmailProvider = (id, to) =>
  api.post(`/settings/email/providers/${id}/test`, to ? { to } : {}).then((r) => r.data?.data);

/** → { authUrl, redirectUri } */
export const connectGoogleEmailProvider = (id) =>
  api.post(`/settings/email/providers/${id}/google/connect`).then((r) => r.data?.data);
