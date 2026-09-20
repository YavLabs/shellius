import api from './api';

// mode: 'full' (default — CA trust, sshd, check-principals, JIT) or
// 'posture' (collector-only; see docs/posture/posture-spec.md §4).
export const createBootstrapToken = (serverId, mode) =>
  api.post('/bootstrap/token', { serverId, ...(mode ? { mode } : {}) }).then((r) => r.data.data);

export const createUninstallToken = (serverId) =>
  api.post('/bootstrap/uninstall-token', { serverId }).then((r) => r.data.data);
