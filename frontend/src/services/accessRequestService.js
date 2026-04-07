import api from './api';

// Unwrap helpers — the backend returns { success, data, meta }. The detail/
// review/create/revoke routes wrap the row as { data: { accessRequest } };
// the list route returns { data: result } where result is { items, total }.
const unwrapAr = (r) => r.data?.data?.accessRequest ?? r.data?.data ?? r.data;

export const listAccessRequests = (params) =>
  api.get('/access-requests', { params }).then((r) => ({
    data: r.data?.data ?? r.data,
    meta: r.data?.meta,
  }));

export const getAccessRequest = (id) =>
  api.get(`/access-requests/${id}`).then(unwrapAr);

export const createAccessRequest = (body) =>
  api.post('/access-requests', body).then(unwrapAr);

export const reviewAccessRequest = (id, body) =>
  api.patch(`/access-requests/${id}/review`, body).then(unwrapAr);

export const revokeAccessRequest = (id, body) =>
  api.post(`/access-requests/${id}/revoke`, body).then(unwrapAr);

export const getSshCredentials = (id) =>
  api
    .post(`/access-requests/${id}/ssh-credentials`)
    .then((r) => r.data?.data?.credentials ?? r.data?.data ?? r.data);

export const getRdpCredentials = (id) =>
  api.post(`/access-requests/${id}/rdp-credentials`).then((r) => r.data?.data ?? r.data);

export const startConnect = (id) =>
  api.post(`/access-requests/${id}/connect`).then((r) => r.data?.data ?? r.data);

export const getRdpGatewayToken = (id) =>
  api.post(`/access-requests/${id}/rdp-token`).then((r) => r.data?.data ?? r.data);

export const getActiveAccessForServer = (serverId) =>
  api
    .get(`/access-requests/by-server/${serverId}/active`)
    .then((r) => r.data?.data?.accessRequest ?? r.data?.data ?? null);
