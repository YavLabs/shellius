import api from './api';

const data = (r) => r.data?.data ?? r.data;

// ---------------------------------------------------------------------------
// Personal access tokens — /api/tokens (permission tokens.personal). Always
// the caller's own tokens; permissions are narrowed to their live role, so a
// personal token can never do more than the person who minted it. The
// plaintext value comes back only from create/rotate — nothing else ever
// returns or stores it, so callers must hand it straight to
// TokenRevealDialog and then discard it.
// ---------------------------------------------------------------------------

/** GET /api/tokens → Token[] */
export const listMyTokens = () => api.get('/tokens').then((r) => data(r) ?? []);

/** POST /api/tokens { name, description?, scopes?, expiresInDays? } → { token, apiToken } */
export const createMyToken = (body) => api.post('/tokens', body).then((r) => data(r));

/** POST /api/tokens/:id/rotate → { token, apiToken } — old value stops working immediately. */
export const rotateMyToken = (id) => api.post(`/tokens/${id}/rotate`).then((r) => data(r));

/** DELETE /api/tokens/:id → { revoked: true } */
export const revokeMyToken = (id) => api.delete(`/tokens/${id}`).then((r) => data(r));

// ---------------------------------------------------------------------------
// Service accounts — /api/service-accounts. Org-owned machine identities
// (CI, Terraform); each is a real user row with its own Role and customer
// scope, and can hold several tokens.
// ---------------------------------------------------------------------------

/** GET /api/service-accounts (service_accounts.view) → ServiceAccount[] */
export const listServiceAccounts = () => api.get('/service-accounts').then((r) => data(r) ?? []);

/** GET /api/service-accounts/:id → ServiceAccount (includes tokens: Token[]) */
export const getServiceAccount = (id) => api.get(`/service-accounts/${id}`).then((r) => data(r));

/** POST /api/service-accounts (service_accounts.manage) { name, description?, roleId, accessScope?, customerIds? } */
export const createServiceAccount = (body) => api.post('/service-accounts', body).then((r) => data(r));

/** PUT /api/service-accounts/:id { name?, description?, roleId?, status?, accessScope?, customerIds? } */
export const updateServiceAccount = (id, body) => api.put(`/service-accounts/${id}`, body).then((r) => data(r));

/** DELETE /api/service-accounts/:id */
export const deleteServiceAccount = (id) => api.delete(`/service-accounts/${id}`).then((r) => data(r));

/** POST /api/service-accounts/:id/tokens { name, expiresInDays?, scopes? } → { token, apiToken } */
export const createServiceAccountToken = (id, body) =>
  api.post(`/service-accounts/${id}/tokens`, body).then((r) => data(r));

/** DELETE /api/service-accounts/:id/tokens/:tokenId */
export const revokeServiceAccountToken = (id, tokenId) =>
  api.delete(`/service-accounts/${id}/tokens/${tokenId}`).then((r) => data(r));

// ---------------------------------------------------------------------------
// Other people's tokens — existing /api/users router, admin oversight only.
// Never returns a plaintext value; list only ever has tokenPrefix.
// ---------------------------------------------------------------------------

/** GET /api/users/:id/tokens (tokens.view_all) → Token[] */
export const listUserTokens = (userId) => api.get(`/users/${userId}/tokens`).then((r) => data(r) ?? []);

/** DELETE /api/users/:id/tokens/:tokenId (tokens.revoke_any) */
export const revokeUserToken = (userId, tokenId) =>
  api.delete(`/users/${userId}/tokens/${tokenId}`).then((r) => data(r));
