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
