import api from './api';

// Auth device/refresh-token-family sessions — distinct from SSH/RDP target
// sessions (see services/sessionService.js).
export const listAuthSessions = () =>
  api.get('/auth/sessions').then((r) => r.data?.data?.sessions ?? r.data?.data ?? []);

export const revokeAuthSession = (id) =>
  api.delete(`/auth/sessions/${id}`).then((r) => r.data?.data ?? r.data);

export const revokeOtherAuthSessions = () =>
  api.post('/auth/sessions/revoke-others').then((r) => r.data?.data ?? r.data);
