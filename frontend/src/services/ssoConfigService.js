import api from './api';

const unwrapCfg = (r) => r.data?.data?.config ?? r.data?.data ?? r.data;

export const getSsoConfig = () => api.get('/auth/sso/config').then(unwrapCfg);
// Full payload incl. env defaults (for prefill) + provisioning fields.
export const getSsoEffective = () => api.get('/auth/sso/config').then((r) => r.data?.data ?? {});
export const saveSsoConfig = (body) => api.put('/auth/sso/config', body).then(unwrapCfg);
export const testSsoConnection = (body) =>
  api.post('/auth/sso/config/test', body).then((r) => r.data?.data ?? r.data);
