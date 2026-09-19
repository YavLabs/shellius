import api from './api';

// Personal vault + My hosts — /api/vault (docs/personal-vault.md).

// { enabled, canUseVault, canUseHosts, canUseOrgIdentities }
export const getVaultStatus = () => api.get('/vault/status').then((r) => r.data.data);

export const listVaultHosts = () =>
  api.get('/vault/hosts').then((r) => r.data.data?.hosts ?? []);

// { name, host, port?, username?, credentialId?, description?, tags?, newIdentity? }
export const createVaultHost = (data) =>
  api.post('/vault/hosts', data).then((r) => r.data.data?.host);

export const updateVaultHost = (id, data) =>
  api.patch(`/vault/hosts/${id}`, data).then((r) => r.data.data?.host);

export const deleteVaultHost = (id) => api.delete(`/vault/hosts/${id}`).then((r) => r.data.data);

// `auth` (one-off, only when the host has no linked identity):
//   { type: 'password', password } | { type: 'key', privateKey, passphrase?, password? }
// -> { ticket, expiresIn } — open the terminal with the ticket exactly like Quick Connect.
export const connectVaultHost = (id, data) =>
  api.post(`/vault/hosts/${id}/connect`, data || {}).then((r) => r.data.data);

export const resetVaultHostKey = (id) =>
  api.post(`/vault/hosts/${id}/host-key/reset`).then((r) => r.data.data?.host);
