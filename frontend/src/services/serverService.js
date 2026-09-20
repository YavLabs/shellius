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
export const getServerDeleteImpact = (id) =>
  api.get(`/servers/${id}/delete-impact`).then((r) => r.data.data);
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
export const resetHostKey = (id) =>
  api.post(`/servers/${id}/host-key/reset`).then((r) => r.data?.data?.server ?? r.data?.data);

export async function provisionServer(serverId, { privateKey, passphrase, password, sshUser, sudoPassword, credentialId, mode, onLog }) {
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
      body: JSON.stringify({ privateKey, passphrase, password, sshUser, sudoPassword, credentialId, mode }),
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

// ---------------------------------------------------------------------------
// Bulk bootstrap / collector install
// ---------------------------------------------------------------------------

/**
 * What a bulk run would do, before it does any of it. Read-only — the
 * interesting part is the hosts it will skip and why.
 */
export const planBulkInstall = (payload) =>
  api.post('/servers/bulk-install/plan', payload).then((r) => r.data?.data ?? r.data);

/** One install command per host, for the manual path. */
export const createBulkBootstrapTokens = (payload) =>
  api.post('/bootstrap/bulk-token', payload).then((r) => r.data?.data ?? r.data);

/**
 * Run the bulk installer. SSE, like the single-host provision, but the event
 * stream carries several hosts at once so every event is dispatched by name
 * rather than collapsed into one log.
 *
 * Events: start, server-start, log, server-done, done, error. Each carries
 * the server id it belongs to (except start/done, which describe the batch).
 *
 * Returns an abort handle: navigating away or pressing Stop must actually
 * stop the run, not leave N SSH sessions installing software unattended.
 */
export function runBulkInstall(payload, handlers = {}) {
  const controller = new AbortController();
  const token = localStorage.getItem('accessToken');

  const promise = (async () => {
    const response = await fetch('/api/servers/bulk-install', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      credentials: 'include',
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data?.error?.message || `HTTP ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    const dispatch = (block) => {
      let type = '';
      let data = '';
      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) type = line.slice(7).trim();
        else if (line.startsWith('data: ')) data = line.slice(6).trim();
      }
      if (!type) return;
      let payloadObj = {};
      try {
        payloadObj = data ? JSON.parse(data) : {};
      } catch {
        return;
      }
      handlers[type]?.(payloadObj);
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop();
      parts.forEach(dispatch);
    }
  })();

  return { promise, abort: () => controller.abort() };
}
