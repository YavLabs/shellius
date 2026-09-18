import api from './api';

// ---------------------------------------------------------------------------
// Keys — /keystore/keys
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Deployments — /keystore/deployments
// ---------------------------------------------------------------------------

export const listDeployments = (params) =>
  api.get('/keystore/deployments', { params }).then((r) => r.data.data);

export const listDeploymentBatches = (params) =>
  api.get('/keystore/deployments/batches', { params }).then((r) => r.data.data?.batches ?? []);

export const createDeployments = (data) =>
  api.post('/keystore/deployments', data).then((r) => r.data.data);

export const retryDeployment = (id) =>
  api.post(`/keystore/deployments/${id}/retry`).then((r) => r.data.data?.deployment);
