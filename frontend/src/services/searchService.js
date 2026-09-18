import api from './api';

/**
 * Global search — GET /api/search?q=&limit=
 *
 * Returns `{ results: { servers, customers, users, identities, keys, policies },
 * counts }`. See docs/keystore-and-quick-connect.md "Global search".
 *
 * Callers should pass an AbortController signal so stale requests (from a
 * fast-typing user) can be cancelled instead of racing the UI.
 */
export const globalSearch = (q, { limit = 5, signal } = {}) =>
  api.get('/search', { params: { q, limit }, signal }).then((r) => r.data?.data ?? r.data);
