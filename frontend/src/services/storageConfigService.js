import api from './api';

const unwrap = (r) => r.data?.data?.config ?? r.data?.data ?? r.data;

export const getStorageConfig = () => api.get('/settings/storage').then(unwrap);

export const saveStorageConfig = (body) =>
  api.put('/settings/storage', body).then(unwrap);

export const deleteStorageConfig = () =>
  api.delete('/settings/storage').then((r) => r.data ?? null);

export const testStorageConfig = () =>
  api.post('/settings/storage/test').then((r) => r.data?.data ?? r.data);
