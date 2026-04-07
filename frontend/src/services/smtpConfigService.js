import api from './api';

const unwrap = (r) => r.data?.data?.config ?? r.data?.data ?? r.data;

export const getSmtpConfig = () => api.get('/settings/smtp').then(unwrap);

export const saveSmtpConfig = (body) =>
  api.put('/settings/smtp', body).then(unwrap);

export const deleteSmtpConfig = () =>
  api.delete('/settings/smtp').then((r) => r.data ?? null);

export const testSmtpConfig = () =>
  api.post('/settings/smtp/test').then((r) => r.data?.data ?? r.data);
