import api from './api';

const unwrapOrg = (r) => r.data?.data?.organization ?? r.data?.data ?? r.data;

export const getOrg = () => api.get('/org').then(unwrapOrg);
export const updateOrg = (data) => api.put('/org', data).then(unwrapOrg);

// Production approval bypass policy — docs/auth-hardening.md "Production
// approval". GET is admin+, PUT is super_admin only.
export const getAccessSettings = () =>
  api.get('/org/access-settings').then((r) => r.data?.data ?? r.data);
export const updateAccessSettings = (data) =>
  api.put('/org/access-settings', data).then((r) => r.data?.data ?? r.data);
