import api from './api';

const unwrap = (r) => r.data?.data ?? r.data;

// Self-service (authenticated)
export const getMfa = () => api.get('/mfa').then(unwrap);
export const beginTotp = () => api.post('/mfa/totp/begin').then(unwrap);
export const confirmTotp = (code) => api.post('/mfa/totp/confirm', { code }).then(unwrap);
export const enableEmailMfa = () => api.post('/mfa/email/enable').then(unwrap);
// `verification` is { method, code } or { password } — required by the
// hardened API for both of these (previously unauthenticated no-ops).
export const regenerateBackupCodes = (verification) =>
  api.post('/mfa/backup-codes/regenerate', verification).then(unwrap);
export const disableMfa = (verification) => api.post('/mfa/disable', verification).then(unwrap);
// ASSUMPTION (not in docs/auth-hardening.md): a self-service equivalent of
// /auth/mfa/send-otp for an already-authenticated user who needs an email
// code to verify a disable/regenerate action. If the backend doesn't expose
// this, the email option in VerifyAction should be hidden/adjusted.
export const sendMfaEmailCode = () => api.post('/mfa/email/send-code').then(unwrap);

// Login challenge (public)
export const verifyMfa = (mfaToken, method, code) =>
  api.post('/auth/mfa/verify', { mfaToken, method, code }).then(unwrap);
export const sendMfaOtp = (mfaToken) => api.post('/auth/mfa/send-otp', { mfaToken }).then(unwrap);

// Super-admin config
export const getMfaConfig = () => api.get('/settings/mfa').then((r) => r.data?.data?.config ?? r.data);
export const saveMfaConfig = (body) => api.put('/settings/mfa', body).then((r) => r.data?.data?.config ?? r.data);

// Which enrolled factor sign-in asks for first ('totp' | 'email').
export const setPreferredMfaMethod = (method) => api.put('/mfa/preferred', { method }).then(unwrap);
