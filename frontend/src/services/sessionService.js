import api from './api';

const unwrapSession = (r) => r.data?.data?.session ?? r.data?.data ?? r.data;

export const listSessions = (params) =>
  api.get('/sessions', { params }).then((r) => r.data);

export const listActiveSessions = (params) =>
  api.get('/sessions/active', { params }).then((r) => r.data);

export const getSession = (id) =>
  api.get(`/sessions/${id}`).then(unwrapSession);

export const terminateSession = (id) =>
  api.post(`/sessions/${id}/terminate`).then(unwrapSession);
