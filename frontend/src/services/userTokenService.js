import api from './api';

export const getInvite = (token) =>
  api.get(`/auth/invite/${token}`).then((r) => r.data?.data ?? r.data);

export const acceptInvite = (token, password) =>
  api.post(`/auth/invite/${token}/accept`, { password }).then((r) => r.data?.data ?? r.data);

export const getResetToken = (token) =>
  api.get(`/auth/password-reset/${token}`).then((r) => r.data?.data ?? r.data);

export const resetPassword = (token, password) =>
  api.post(`/auth/password-reset/${token}/reset`, { password }).then((r) => r.data?.data ?? r.data);

export const requestPasswordReset = (email) =>
  api.post('/auth/password-reset', { email }).then((r) => r.data ?? null);
