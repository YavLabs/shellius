import api from './api';

export const getQuickConnectSettings = () =>
  api.get('/quick-connect/settings').then((r) => r.data.data);

export const updateQuickConnectSettings = (data) =>
  api.put('/quick-connect/settings', data).then((r) => r.data.data);

export const createQuickConnectTicket = (data) =>
  api.post('/quick-connect/tickets', data).then((r) => r.data.data);

export const saveQuickConnectServer = (data) =>
  api.post('/quick-connect/save', data).then((r) => r.data.data?.server);
