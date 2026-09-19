import api from './api';

export const getQuickConnectSettings = () =>
  api.get('/quick-connect/settings').then((r) => r.data.data);

export const updateQuickConnectSettings = (data) =>
  api.put('/quick-connect/settings', data).then((r) => r.data.data);

// Timed out so a stalled request surfaces an error instead of a spinner
// that never stops (see QuickConnectModal's error handling).
export const QUICK_CONNECT_TIMEOUT_MS = 45000;

export const createQuickConnectTicket = (data) =>
  api.post('/quick-connect/tickets', data, { timeout: QUICK_CONNECT_TIMEOUT_MS }).then((r) => r.data.data);

export const saveQuickConnectServer = (data) =>
  api.post('/quick-connect/save', data).then((r) => r.data.data?.server);

// --- Quick Connect history (dashboard "Recent Quick Connects") -----------
// Per-user, no secrets, retained 7 days.

export const getHistory = (params) =>
  api.get('/quick-connect/history', { params }).then((r) => r.data.data?.items || []);

export const reconnectHistory = (id) =>
  api.post(`/quick-connect/history/${id}/reconnect`).then((r) => r.data.data);

export const deleteHistory = (id) => api.delete(`/quick-connect/history/${id}`).then((r) => r.data.data);

export const clearHistory = () => api.delete('/quick-connect/history').then((r) => r.data.data);
