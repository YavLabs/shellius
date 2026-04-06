import api from './api';

export const getCaPublicKey = () =>
  api.get('/ca/public-key').then((r) => r.data.data);
export const generateCa = () =>
  api.post('/ca/generate').then((r) => r.data.data);
export const rotateCa = () =>
  api.post('/ca/rotate').then((r) => r.data.data);
export const getCaFingerprint = () =>
  api.get('/ca/fingerprint').then((r) => r.data.data);
