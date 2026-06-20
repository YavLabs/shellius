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

// Fetch the template through the authenticated client (the endpoint requires a
// bearer token, so a plain <a href> would 401) and trigger a file download.
export const downloadTemplate = async (entity) => {
  const res = await api.get(`/import/templates/${entity}.csv`, { responseType: 'blob' });
  const url = window.URL.createObjectURL(new Blob([res.data], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${entity}-template.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.URL.revokeObjectURL(url);
};
