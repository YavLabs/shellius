import api from './api';

const unwrap = (r) => r.data?.data ?? r.data;

// Self-service (authenticated)
export const getMfa = () => api.get('/mfa').then(unwrap);
export const beginTotp = () => api.post('/mfa/totp/begin').then(unwrap);
export const confirmTotp = (code) => api.post('/mfa/totp/confirm', { code }).then(unwrap);
export const enableEmailMfa = () => api.post('/mfa/email/enable').then(unwrap);
export const regenerateBackupCodes = () => api.post('/mfa/backup-codes/regenerate').then(unwrap);
export const disableMfa = () => api.post('/mfa/disable').then(unwrap);

// Login challenge (public)
export const verifyMfa = (mfaToken, method, code) =>
  api.post('/auth/mfa/verify', { mfaToken, method, code }).then(unwrap);
export const sendMfaOtp = (mfaToken) => api.post('/auth/mfa/send-otp', { mfaToken }).then(unwrap);

// Super-admin config
export const getMfaConfig = () => api.get('/settings/mfa').then((r) => r.data?.data?.config ?? r.data);
export const saveMfaConfig = (body) => api.put('/settings/mfa', body).then((r) => r.data?.data?.config ?? r.data);
