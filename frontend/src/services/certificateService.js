import api from './api';

export const listCertificates = (params) =>
  api.get('/certificates', { params }).then((r) => r.data.data);
export const getCertificate = (id) =>
  api.get(`/certificates/${id}`).then((r) => r.data.data);
export const issueCertificate = (data) =>
  api.post('/certificates', data).then((r) => r.data.data);
export const revokeCertificate = (id) =>
  api.delete(`/certificates/${id}`).then((r) => r.data.data);
export const verifyCertificate = (serial) =>
  api.post('/certificates/verify', { serial }).then((r) => r.data.data);
