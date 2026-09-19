import api from './api';

// /api/roles — custom roles and the permission catalogue.
const data = (r) => r.data?.data ?? r.data;

export const getPermissionCatalog = () => api.get('/roles/catalog').then(data);
export const listRoles = () => api.get('/roles').then((r) => data(r).roles || []);
export const getRole = (id) => api.get(`/roles/${id}`).then((r) => data(r).role);
export const createRole = (body) => api.post('/roles', body).then((r) => data(r).role);
export const updateRole = (id, body) => api.put(`/roles/${id}`, body).then((r) => data(r).role);
export const resetRole = (id) => api.post(`/roles/${id}/reset`).then((r) => data(r).role);
export const deleteRole = (id, body = {}) => api.delete(`/roles/${id}`, { data: body }).then(data);
