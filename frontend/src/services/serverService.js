import api from './api';

export const listServers = (params) =>
  api.get('/servers', { params }).then((r) => r.data.data);
export const getServer = (id) =>
  api.get(`/servers/${id}`).then((r) => r.data.data);
export const createServer = (data) =>
  api.post('/servers', data).then((r) => r.data.data);
export const updateServer = (id, data) =>
  api.put(`/servers/${id}`, data).then((r) => r.data.data);
export const deleteServer = (id) =>
  api.delete(`/servers/${id}`).then((r) => r.data.data);
export const bulkUpdateEnvironment = (serverIds, environment) =>
  api
    .post('/servers/bulk/environment', { serverIds, environment })
    .then((r) => r.data.data);
export const triggerHealthCheck = (id) =>
  api.post(`/servers/${id}/health-check`).then((r) => r.data.data);
