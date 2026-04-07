import api from './api';

export const getRegistrationStatus = () =>
  api.get('/auth/registration-status').then((r) => r.data?.data?.enabled ?? false);

export const register = (body) =>
  api.post('/auth/register', body).then((r) => r.data?.data ?? r.data);

export const verifyEmail = (token) =>
  api.post(`/auth/verify-email/${token}`).then((r) => r.data?.data ?? r.data);
