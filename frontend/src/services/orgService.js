import api from './api';

const unwrapOrg = (r) => r.data?.data?.organization ?? r.data?.data ?? r.data;

export const getOrg = () => api.get('/org').then(unwrapOrg);
export const updateOrg = (data) => api.put('/org', data).then(unwrapOrg);
