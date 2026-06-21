import api from './api';

export const listGroups = () =>
  api.get('/groups').then((r) => r.data.data?.groups ?? r.data.data ?? []);
export const getGroup = (id) =>
  api.get(`/groups/${id}`).then((r) => r.data.data?.group ?? r.data.data);
export const createGroup = (data) =>
  api.post('/groups', data).then((r) => r.data.data?.group ?? r.data.data);
export const updateGroup = (id, data) =>
  api.put(`/groups/${id}`, data).then((r) => r.data.data?.group ?? r.data.data);
export const getGroupDeleteImpact = (id) =>
  api.get(`/groups/${id}/delete-impact`).then((r) => r.data.data);
export const deleteGroup = (id) =>
  api.delete(`/groups/${id}`).then((r) => r.data.data);
export const addGroupMember = (id, userId) =>
  api.post(`/groups/${id}/members`, { userId }).then((r) => r.data.data);
export const removeGroupMember = (id, userId) =>
  api.delete(`/groups/${id}/members/${userId}`).then((r) => r.data.data);
