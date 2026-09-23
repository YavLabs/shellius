import api from './api';

// /api/chat/identities — linking a chat account (Slack today) to the
// signed-in Shellius user. See backend/src/routes/chatIdentities.js and
// pages/ChatLink.jsx: the button press in chat proves the chat half, this
// authenticated session proves the Shellius half — neither is enough alone.

/** GET /api/chat/identities/pending/:token → { platform, workspaceId, displayName }. */
export const getPendingChatLink = (token) =>
  api.get(`/chat/identities/pending/${token}`).then((r) => r.data?.data ?? r.data);

/** POST /api/chat/identities/link → { id, platform, linkedAt }. */
export const confirmChatLink = (token) =>
  api.post('/chat/identities/link', { token }).then((r) => r.data?.data ?? r.data);

/** GET /api/chat/identities → this user's linked chat accounts. */
export const listMyChatIdentities = () =>
  api.get('/chat/identities').then((r) => r.data?.data ?? []);

/** DELETE /api/chat/identities/:id */
export const unlinkChatIdentity = (id) =>
  api.delete(`/chat/identities/${id}`).then((r) => r.data?.data ?? r.data);
