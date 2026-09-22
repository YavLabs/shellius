import api from './api';

// ---------------------------------------------------------------------------
// Keys — /keystore/keys
// ---------------------------------------------------------------------------
// Every list/create call is scope-aware (docs/personal-vault.md): pass
// `{ scope: 'personal' }` in params/body to work the caller's own private
// items instead of the org's (default `scope: 'org'`, needs keystore.view /
// keystore.manage; `personal` needs vault.use + the org's vault switch).

export const listKeys = (params) =>
  api.get('/keystore/keys', { params }).then((r) => r.data.data?.keys ?? []);

export const getKey = (id) =>
  api.get(`/keystore/keys/${id}`).then((r) => r.data.data);

export const generateKey = (data) =>
  api.post('/keystore/keys/generate', data).then((r) => r.data.data?.key);

export const importKey = (data) =>
  api.post('/keystore/keys/import', data).then((r) => r.data.data?.key);

// { privateKey, passphrase? } -> { format, encrypted, keyType, bits, fingerprint, publicKey, comment }
// Nothing is stored server-side. Throws on KEY_PASSPHRASE_REQUIRED / KEY_PASSPHRASE_INVALID /
// KEY_UNSUPPORTED_FORMAT / KEY_UNSUPPORTED_TYPE.
export const inspectKey = (data) =>
  api.post('/keystore/keys/inspect', data).then((r) => r.data.data);

export const updateKey = (id, data) =>
  api.patch(`/keystore/keys/${id}`, data).then((r) => r.data.data?.key);

export const deleteKey = (id) => api.delete(`/keystore/keys/${id}`).then((r) => r.data.data);

export const exportKey = (id) =>
  api.post(`/keystore/keys/${id}/export`, { includePrivate: true }).then((r) => r.data.data);

// ---------------------------------------------------------------------------
// Identities (Credentials) — /keystore/credentials
// ---------------------------------------------------------------------------

export const listCredentials = (params) =>
  api.get('/keystore/credentials', { params }).then((r) => r.data.data?.credentials ?? []);

export const getCredential = (id) =>
  api.get(`/keystore/credentials/${id}`).then((r) => r.data.data);

export const createCredential = (data) =>
  api.post('/keystore/credentials', data).then((r) => r.data.data?.credential);

export const updateCredential = (id, data) =>
  api.patch(`/keystore/credentials/${id}`, data).then((r) => r.data.data?.credential);

export const deleteCredential = (id, { force = false } = {}) =>
  api
    .delete(`/keystore/credentials/${id}`, { params: force ? { force: true } : undefined })
    .then((r) => r.data.data);

export const testCredential = (id, data) =>
  api.post(`/keystore/credentials/${id}/test`, data).then((r) => r.data.data);

// Personal → org, one-way (docs/personal-vault.md rule 6). Owner + keystore.manage.
export const moveCredentialToOrg = (id) =>
  api.post(`/keystore/credentials/${id}/move-to-org`).then((r) => r.data.data?.credential);

export const moveKeyToOrg = (id) =>
  api.post(`/keystore/keys/${id}/move-to-org`).then((r) => r.data.data?.key);

// ---------------------------------------------------------------------------
// Deployments — /keystore/deployments
// ---------------------------------------------------------------------------

// The route sends pagination as a top-level `meta`, not nested under `data`
// (unlike most list endpoints) — flatten it here so callers get one object:
// { deployments, total, page, pageSize }.
export const listDeployments = (params) =>
  api.get('/keystore/deployments', { params }).then((r) => ({
    deployments: r.data.data?.deployments ?? [],
    total: r.data.meta?.total ?? 0,
    page: r.data.meta?.page ?? 1,
    pageSize: r.data.meta?.pageSize ?? 25,
  }));

// Group tree over the whole filtered set: { groupBy, tree, active }, where
// `active` counts matching rows still pending/running. Takes the list's
// filters plus `groupBy` ('batch,status').
export const listDeploymentGroups = (params) =>
  api.get('/keystore/deployments/groups', { params }).then((r) => r.data.data ?? { groupBy: [], tree: [], active: 0 });

export const createDeployments = (data) =>
  api.post('/keystore/deployments', data).then((r) => r.data.data);

export const retryDeployment = (id) =>
  api.post(`/keystore/deployments/${id}/retry`).then((r) => r.data.data?.deployment);
