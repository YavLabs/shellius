import api from './api';

export const listUsers = (params) =>
  api.get('/users', { params }).then((r) => r.data.data);
export const getUser = (id) => api.get(`/users/${id}`).then((r) => r.data.data);
export const createUser = (data) => api.post('/users', data).then((r) => r.data.data);
export const updateUser = (id, data) =>
  api.put(`/users/${id}`, data).then((r) => r.data.data);
export const deleteUser = (id) => api.delete(`/users/${id}`).then((r) => r.data.data);
export const uploadSshKey = (id, publicKey) =>
  api.put(`/users/${id}/ssh-key`, { publicKey }).then((r) => r.data.data);
export const removeSshKey = (id) =>
  api.delete(`/users/${id}/ssh-key`).then((r) => r.data.data);
