import api from './api';

// ---------------------------------------------------------------------------
// Legacy single-provider config — kept working against the first provider
// per docs/auth-hardening.md ("Legacy GET/PUT /api/auth/sso/config keep
// working against the first provider"). No longer used by SsoTab itself, but
// left in place in case anything else still reads it.
// ---------------------------------------------------------------------------
const unwrapCfg = (r) => r.data?.data?.config ?? r.data?.data ?? r.data;

export const getSsoConfig = () => api.get('/auth/sso/config').then(unwrapCfg);
export const getSsoEffective = () => api.get('/auth/sso/config').then((r) => r.data?.data ?? {});
export const saveSsoConfig = (body) => api.put('/auth/sso/config', body).then(unwrapCfg);
export const testSsoConnection = (body) =>
  api.post('/auth/sso/config/test', body).then((r) => r.data?.data ?? r.data);

// ---------------------------------------------------------------------------
// Multi-provider SSO (Revision 2) — docs/auth-hardening.md "Multiple SSO
// providers (incl. GitHub)".
// ---------------------------------------------------------------------------

/** GET /api/auth/sso/providers → { providers: SsoProviderDTO[] } */
export const listSsoProviders = () =>
  api.get('/auth/sso/providers').then((r) => r.data?.data?.providers ?? r.data?.data ?? []);

/** POST /api/auth/sso/providers → 201 { provider } */
export const createSsoProvider = (body) =>
  api.post('/auth/sso/providers', body).then((r) => r.data?.data?.provider ?? r.data?.data);

/** PATCH /api/auth/sso/providers/:id — all fields optional; blank clientSecret keeps stored. */
export const updateSsoProvider = (id, body) =>
  api.patch(`/auth/sso/providers/${id}`, body).then((r) => r.data?.data?.provider ?? r.data?.data);

/**
 * DELETE /api/auth/sso/providers/:id — 409 LAST_SIGN_IN_METHOD if any linked
 * user would be left with no way to sign in. Pass `force: true` to override.
 */
export const deleteSsoProvider = (id, { force = false } = {}) =>
  api
    .delete(`/auth/sso/providers/${id}`, { params: force ? { force: true } : undefined })
    .then((r) => r.data?.data ?? r.data);

/** PUT /api/auth/sso/providers/order { ids: [] } */
export const reorderSsoProviders = (ids) =>
  api.put('/auth/sso/providers/order', { ids }).then((r) => r.data?.data ?? r.data);

/** POST /api/auth/sso/providers/:id/test — test a saved provider. */
export const testSavedSsoProvider = (id) =>
  api.post(`/auth/sso/providers/${id}/test`).then((r) => r.data?.data ?? r.data);

/** POST /api/auth/sso/providers/test — test an unsaved draft config. */
export const testDraftSsoProvider = (body) =>
  api.post('/auth/sso/providers/test', body).then((r) => r.data?.data ?? r.data);

// ---------------------------------------------------------------------------
// Public / login-time provider discovery
// ---------------------------------------------------------------------------

/** GET /api/auth/sso/public-status?orgSlug= → { enabled, presetId, orgSlug, providers } */
export const getSsoPublicStatus = (orgSlug) =>
  api
    .get('/auth/sso/public-status', { params: orgSlug ? { orgSlug } : undefined })
    .then((r) => r.data?.data ?? {});

// ---------------------------------------------------------------------------
// Linked identities (Profile > Sign-in methods)
// ---------------------------------------------------------------------------

/**
 * DELETE /api/auth/identities/:id — unlink a linked SSO identity from the
 * current user. 409 LAST_SIGN_IN_METHOD if it would leave the account with
 * no way to sign in.
 */
export const unlinkIdentity = (id) =>
  api.delete(`/auth/identities/${id}`).then((r) => r.data?.data ?? r.data);
