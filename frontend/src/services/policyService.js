import api from './api';

export const listPolicies = (params) =>
  api.get('/policies', { params }).then((r) => r.data);

export const getPolicy = (id) =>
  api.get(`/policies/${id}`).then((r) => r.data.data);

export const createPolicy = (body) =>
  api.post('/policies', body).then((r) => r.data.data);

export const updatePolicy = (id, body) =>
  api.put(`/policies/${id}`, body).then((r) => r.data.data);

export const deletePolicy = (id) =>
  api.delete(`/policies/${id}`).then((r) => r.data.data);

export const evaluatePolicy = (body) =>
  api.post('/policies/evaluate', body).then((r) => r.data.data);

export const getMyAccess = () =>
  api.get('/policies/my-access').then((r) => r.data.data);
