import api from './api';

const unwrapUser = (r) => r.data?.data?.user ?? r.data?.data ?? r.data;

export const listUsers = (params) =>
  api.get('/users', { params }).then((r) => r.data?.data ?? r.data);
export const getUser = (id) => api.get(`/users/${id}`).then(unwrapUser);
export const createUser = (data) => api.post('/users', data).then(unwrapUser);
export const updateUser = (id, data) =>
  api.put(`/users/${id}`, data).then(unwrapUser);
export const getUserDeleteImpact = (id) =>
  api.get(`/users/${id}/delete-impact`).then((r) => r.data.data);
export const deleteUser = (id, options = {}) =>
  api.delete(`/users/${id}`, { data: options }).then((r) => r.data?.data ?? r.data);
export const uploadSshKey = (id, publicKey) =>
  api.put(`/users/${id}/ssh-key`, { publicKey }).then((r) => r.data?.data ?? r.data);
export const removeSshKey = (id) =>
  api.delete(`/users/${id}/ssh-key`).then((r) => r.data?.data ?? r.data);

export const resendInvite = (id) =>
  api.post(`/users/${id}/resend-invite`).then((r) => r.data?.data ?? r.data);

export const triggerPasswordReset = (id) =>
  api.post(`/users/${id}/password-reset`).then((r) => r.data?.data ?? r.data);

// Auth hardening — admin actions
export const unlockUser = (id) =>
  api.post(`/users/${id}/unlock`).then((r) => r.data?.data ?? r.data);
export const revokeUserSessions = (id) =>
  api.post(`/users/${id}/revoke-sessions`).then((r) => r.data?.data ?? r.data);

// Profile / GDPR (Phase 17F)
export const getMe = () => api.get('/users/me').then((r) => r.data?.data?.user ?? r.data?.data);
export const updateMe = (data) =>
  api.put('/users/me', data).then((r) => r.data?.data?.user ?? r.data?.data);
export const changeMyPassword = (body) =>
  api.put('/users/me/password', body).then((r) => r.data?.data ?? r.data);

// Profile avatar — ephemeral client-side crop/resize, uploaded as a data URL.
export const uploadMyAvatar = (dataUrl) =>
  api.put('/users/me/avatar', { dataUrl }).then((r) => r.data?.data?.user ?? r.data?.data);
export const removeMyAvatar = () =>
  api.delete('/users/me/avatar').then((r) => r.data?.data?.user ?? r.data?.data);
export const exportMyData = () =>
  api.get('/users/me/export', { responseType: 'blob' }).then((r) => {
    const url = URL.createObjectURL(new Blob([r.data], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `shellius-export-${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });
export const deleteMyAccount = () =>
  api.delete('/users/me').then((r) => r.data?.data ?? r.data);

// Sign-in methods
/** POST /api/auth/password/set/send-code — email the one-time proof code. */
export const sendSetPasswordCode = () =>
  api.post('/auth/password/set/send-code').then((r) => r.data?.data ?? r.data);
/** POST /api/auth/password/set { newPassword, method, code } — accounts without a password. */
export const setMyPassword = (body) => api.post('/auth/password/set', body).then((r) => r.data?.data ?? r.data);
/** GET /api/users/:id/identities → { hasPassword, passwordUsable, identities } (users.manage_identities). */
export const getUserIdentities = (id) => api.get(`/users/${id}/identities`).then((r) => r.data?.data ?? r.data);
/** DELETE /api/users/:id/identities/:identityId (users.manage_identities). */
export const unlinkUserIdentity = (id, identityId) =>
  api.delete(`/users/${id}/identities/${identityId}`).then((r) => r.data?.data ?? r.data);
