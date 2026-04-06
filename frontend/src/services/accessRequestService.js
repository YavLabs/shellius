import api from './api';

export const listAccessRequests = (params) =>
  api.get('/access-requests', { params }).then((r) => r.data);

export const getAccessRequest = (id) =>
  api.get(`/access-requests/${id}`).then((r) => r.data);

export const createAccessRequest = (body) =>
  api.post('/access-requests', body).then((r) => r.data);

export const reviewAccessRequest = (id, body) =>
  api.patch(`/access-requests/${id}/review`, body).then((r) => r.data);

export const revokeAccessRequest = (id, body) =>
  api.post(`/access-requests/${id}/revoke`, body).then((r) => r.data);

export const getSshCredentials = (id) =>
  api.post(`/access-requests/${id}/ssh-credentials`).then((r) => r.data);

export const getRdpCredentials = (id) =>
  api.post(`/access-requests/${id}/rdp-credentials`).then((r) => r.data);

export const startConnect = (id) =>
  api.post(`/access-requests/${id}/connect`).then((r) => r.data);

export const getRdpGatewayToken = (id) =>
  api.post(`/access-requests/${id}/rdp-token`).then((r) => r.data);
