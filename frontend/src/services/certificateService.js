import api from './api';

const unwrapCert = (r) => r.data?.data?.certificate ?? r.data?.data ?? r.data;

export const listCertificates = (params) =>
  api.get('/certificates', { params }).then((r) => r.data);

export const getMyCerts = (params) =>
  api.get('/certificates/my-certs', { params }).then((r) => r.data);

export const getCertificate = (id) =>
  api.get(`/certificates/${id}`).then(unwrapCert);

export const issueCertificate = (body) =>
  api.post('/certificates/issue', body).then((r) => r.data?.data ?? r.data);

export const revokeCertificate = (id) =>
  api.post(`/certificates/${id}/revoke`).then(unwrapCert);
