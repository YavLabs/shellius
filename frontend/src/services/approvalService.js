import api from './api';

// Public (no-login) one-click approval endpoints — the token is the credential.
export const getApprovalRequest = (token) =>
  api.get(`/approvals/${token}`).then((r) => r.data?.data?.request ?? r.data?.data ?? r.data);

export const submitApprovalDecision = (token, decision, reason) =>
  api
    .post(`/approvals/${token}`, { decision, ...(reason ? { reason } : {}) })
    .then((r) => r.data?.data ?? r.data);
