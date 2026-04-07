import api from './api';

const unwrapUser = (r) => r.data?.data?.user ?? r.data?.data ?? r.data;

export const listUsers = (params) =>
  api.get('/users', { params }).then((r) => r.data?.data ?? r.data);
export const getUser = (id) => api.get(`/users/${id}`).then(unwrapUser);
export const createUser = (data) => api.post('/users', data).then(unwrapUser);
export const updateUser = (id, data) =>
  api.put(`/users/${id}`, data).then(unwrapUser);
export const deleteUser = (id) =>
  api.delete(`/users/${id}`).then((r) => r.data?.data ?? r.data);
export const uploadSshKey = (id, publicKey) =>
  api.put(`/users/${id}/ssh-key`, { publicKey }).then((r) => r.data?.data ?? r.data);
export const removeSshKey = (id) =>
  api.delete(`/users/${id}/ssh-key`).then((r) => r.data?.data ?? r.data);

export const resendInvite = (id) =>
  api.post(`/users/${id}/resend-invite`).then((r) => r.data?.data ?? r.data);

export const triggerPasswordReset = (id) =>
  api.post(`/users/${id}/password-reset`).then((r) => r.data?.data ?? r.data);
