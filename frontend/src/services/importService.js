import api from './api';

export const uploadImport = (file, type) => {
  const form = new FormData();
  form.append('file', file);
  if (type) form.append('type', type);
  return api
    .post('/import', form, { headers: { 'Content-Type': 'multipart/form-data' } })
    .then((r) => r.data?.data ?? r.data);
};

export const getImportJob = (id) => api.get(`/import/${id}`).then((r) => r.data?.data ?? r.data);

export const setImportDecisions = (id, decision, { rowIds = [], applyAll = false } = {}) =>
  api.patch(`/import/${id}/decisions`, { decision, rowIds, applyAll }).then((r) => r.data?.data ?? r.data);

export const commitImport = (id) => api.post(`/import/${id}/commit`).then((r) => r.data?.data ?? r.data);

export const templateUrl = (entity) => `/api/import/templates/${entity}.csv`;
