import { CHAT_VARIANTS } from '@/components/settings/chat/chatTypes';

/**
 * Platform label/icon for a linked chat identity (Profile → "Chat accounts"
 * and /chat/link). Deliberately separate from chatTypes.js's per-*variant*
 * catalogue: a destination has a mode (webhook vs. app), but an identity
 * never does — only Slack's app (bot token) variant can carry the button
 * press that starts a link (see backend/src/services/notify/chatIdentityService.js
 * "Why not match on email"), so there is exactly one identity per platform
 * to label. Icons are still pulled from CHAT_VARIANTS rather than
 * re-imported, so they can never drift from the destination catalogue.
 */

const PLATFORM_LABELS = {
  slack: 'Slack',
  google_chat: 'Google Chat',
  teams: 'Microsoft Teams',
  webhook: 'Webhook',
};

export function platformLabel(platform) {
  if (!platform) return 'Unknown';
  return PLATFORM_LABELS[platform] || CHAT_VARIANTS.find((v) => v.platform === platform)?.label || platform;
}

export function platformIcon(platform) {
  return CHAT_VARIANTS.find((v) => v.platform === platform)?.icon || null;
}

export default { platformLabel, platformIcon };
