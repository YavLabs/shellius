import api from './api';

const unwrapServer = (r) => r.data.data?.server ?? r.data.data;

export const listServers = (params) =>
  api.get('/servers', { params }).then((r) => r.data.data);
export const getServer = (id) =>
  api.get(`/servers/${id}`).then(unwrapServer);
export const createServer = (data) =>
  api.post('/servers', data).then(unwrapServer);
export const updateServer = (id, data) =>
  api.put(`/servers/${id}`, data).then(unwrapServer);
export const deleteServer = (id) =>
  api.delete(`/servers/${id}`).then((r) => r.data.data);
export const bulkUpdateEnvironment = (serverIds, environment) =>
  api
    .post('/servers/bulk/environment', { serverIds, environment })
    .then((r) => r.data.data);
export const triggerHealthCheck = (id) =>
  api.post(`/servers/${id}/health-check`).then(unwrapServer);

/**
 * getServerStats — returns total count and per-environment breakdown.
 * TODO: Replace with a dedicated /api/servers/stats endpoint once backend
 * implements it. Currently fetches up to 500 servers and groups client-side.
 */
export const getServerStats = async () => {
  const data = await api
    .get('/servers', { params: { page: 1, pageSize: 500 } })
    .then((r) => r.data.data);
  const items = data?.items || [];
  const total = data?.total ?? items.length;
  const byEnv = { prod: 0, staging: 0, dev: 0, demo: 0 };
  for (const s of items) {
    const env = s.environment?.toLowerCase();
    if (env in byEnv) byEnv[env]++;
  }
  return { total, byEnv };
};
