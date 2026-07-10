import api from './api';

const unwrapPolicy = (r) => r.data?.data?.policy ?? r.data?.data ?? r.data;

export const listPolicies = (params) =>
  api.get('/policies', { params }).then((r) => r.data);

export const getPolicy = (id) =>
  api.get(`/policies/${id}`).then(unwrapPolicy);

export const createPolicy = (body) =>
  api.post('/policies', body).then(unwrapPolicy);

export const updatePolicy = (id, body) =>
  api.put(`/policies/${id}`, body).then(unwrapPolicy);

export const getPolicyDeleteImpact = (id) =>
  api.get(`/policies/${id}/delete-impact`).then((r) => r.data.data);
export const deletePolicy = (id) =>
  api.delete(`/policies/${id}`).then((r) => r.data?.data ?? r.data);

export const evaluatePolicy = (body) =>
  api.post('/policies/evaluate', body).then((r) => r.data?.data ?? r.data);

export const getMyAccess = () =>
  api
    .get('/policies/my-access')
    .then((r) => r.data?.data?.accessibleServers ?? r.data?.data ?? r.data);
