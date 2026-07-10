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

// Authenticated blob download of the asciinema .cast recording.
export async function downloadRecording(id) {
  const res = await api.get(`/sessions/${id}/recording`, { responseType: 'blob' });
  const url = URL.createObjectURL(res.data);
  const a = document.createElement('a');
  a.href = url;
  a.download = `session-${id}.cast`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
