import api from './api';

export const createBootstrapToken = (serverId) =>
  api.post('/bootstrap/token', { serverId }).then((r) => r.data.data);

export const createUninstallToken = (serverId) =>
  api.post('/bootstrap/uninstall-token', { serverId }).then((r) => r.data.data);
