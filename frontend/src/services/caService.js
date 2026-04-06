import api from './api';

export const getPublicKey = () =>
  api.get('/ca/public-key').then((r) => r.data.data);

export const getStatus = () =>
  api.get('/ca/status').then((r) => r.data.data);

export const rotate = () =>
  api.post('/ca/rotate').then((r) => r.data.data);
