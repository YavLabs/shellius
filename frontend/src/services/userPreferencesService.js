import api from './api';

const unwrapPrefs = (r) => r.data?.data?.preferences ?? r.data?.data ?? r.data;

export const getMyPreferences = () => api.get('/users/me/preferences').then(unwrapPrefs);
export const updateMyPreferences = (data) =>
  api.put('/users/me/preferences', data).then(unwrapPrefs);
