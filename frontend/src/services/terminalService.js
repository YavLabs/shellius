import api from './api';

/**
 * terminalService — REST client for the persistent terminal session hub
 * (`docs/terminal-workspace.md` section 1). Caller's own sessions only.
 */

export const listTerminalSessions = () =>
  api.get('/terminal/sessions').then((r) => r.data?.data?.sessions ?? r.data?.data ?? []);

// Returns { connect: { ticket } | { requestId, principal } } — feed straight
// into TerminalWorkspaceContext.openTab().
export const duplicateTerminalSession = (id) =>
  api.post(`/terminal/sessions/${id}/duplicate`).then((r) => r.data?.data?.connect ?? r.data?.data);

export const renameTerminalSession = (id, label) =>
  api.patch(`/terminal/sessions/${id}`, { label }).then((r) => r.data?.data);

export const closeTerminalSession = (id) =>
  api.post(`/terminal/sessions/${id}/close`).then((r) => r.data?.data);

// Mint a single-use, ~30s WebSocket connect ticket — the access JWT never
// appears in a WS URL (B-6/B-7 hardening). `purpose` is 'ssh' (RDP keeps its
// own short-lived Guacamole gateway token, sent over the tunnel, not a URL).
// Returns { ticket, expiresIn }.
export const requestWsTicket = (purpose, params) =>
  api.post('/terminal/ws-ticket', { purpose, params }).then((r) => r.data?.data);

// A tab lost its live session (backend restart, expiry, admin terminate,
// detach timeout, remote exit…). Returns what happened and the next step:
// { action: 'attach'|'reconnect'|'pending'|'request_access'|'quick_connect'|'none',
//   endReason, actionDetail, server, target, prefill?, requestId?, accessExpiresAt? }
export const getSessionRecovery = (id) =>
  api.get(`/terminal/sessions/${id}/recovery`).then((r) => r.data?.data);

// Connect spec for a new session replacing a lost one (action reconnect/attach).
export const reconnectSession = (id) =>
  api.post(`/terminal/sessions/${id}/reconnect`).then((r) => r.data?.data?.connect);
