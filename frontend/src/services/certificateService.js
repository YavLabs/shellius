import api from './api';

export const listCertificates = (params) =>
  api.get('/certificates', { params }).then((r) => r.data);

export const getMyCerts = (params) =>
  api.get('/certificates/my-certs', { params }).then((r) => r.data);

export const getCertificate = (id) =>
  api.get(`/certificates/${id}`).then((r) => r.data.data);

export const issueCertificate = (body) =>
  api.post('/certificates/issue', body).then((r) => r.data.data);

export const revokeCertificate = (id) =>
  api.post(`/certificates/${id}/revoke`).then((r) => r.data.data);
