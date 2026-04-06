import api from './api';

export const listSessions = (params) =>
  api.get('/sessions', { params }).then((r) => r.data);

export const listActiveSessions = (params) =>
  api.get('/sessions/active', { params }).then((r) => r.data);

export const getSession = (id) =>
  api.get(`/sessions/${id}`).then((r) => r.data);

export const terminateSession = (id) =>
  api.post(`/sessions/${id}/terminate`).then((r) => r.data);
