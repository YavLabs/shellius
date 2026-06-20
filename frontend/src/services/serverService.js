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

export const bulkUpdateServers = (serverIds, patch) =>
  api.post('/servers/bulk', { serverIds, patch }).then((r) => r.data.data);

export const updateConnectionIp = (id, ipAddress) =>
  api.patch(`/servers/${id}/connection-ip`, { ipAddress }).then((r) => r.data?.data?.server ?? r.data?.data);
export const triggerHealthCheck = (id) =>
  api.post(`/servers/${id}/health-check`).then(unwrapServer);

export async function provisionServer(serverId, { privateKey, passphrase, password, sshUser, sudoPassword, onLog }) {
  return new Promise((resolve, reject) => {
    // This is a raw fetch (SSE stream), so it bypasses the axios interceptor —
    // attach the bearer token manually.
    const token = localStorage.getItem('accessToken');
    fetch(`/api/servers/${serverId}/provision`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      credentials: 'include',
      body: JSON.stringify({ privateKey, passphrase, password, sshUser, sudoPassword }),
    }).then(async (response) => {
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        return reject(new Error(data?.error?.message || `HTTP ${response.status}`));
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      const processLines = (text) => {
        buffer += text;
        const parts = buffer.split('\n\n');
        buffer = parts.pop();

        for (const block of parts) {
          const blockLines = block.split('\n');
          let type = '';
          let data = '';
          for (const bl of blockLines) {
            if (bl.startsWith('event: ')) type = bl.slice(7).trim();
            else if (bl.startsWith('data: ')) data = bl.slice(6).trim();
          }
          if (type === 'log' && data) {
            try {
              const p = JSON.parse(data);
              if (p.message && onLog) onLog(p.message);
            } catch { /* ignore */ }
          } else if (type === 'done') {
            resolve();
          } else if (type === 'error' && data) {
            try {
              const p = JSON.parse(data);
              reject(new Error(p.message || 'Provisioning failed'));
            } catch {
              reject(new Error('Provisioning failed'));
            }
          }
        }
      };

      (async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) { resolve(); break; }
          processLines(decoder.decode(value, { stream: true }));
        }
      })();
    }).catch(reject);
  });
}

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
