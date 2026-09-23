import { Bot, Hash, MessageSquare, MessagesSquare, Webhook } from 'lucide-react';

/**
 * Chat destination catalogue for Administration → Chat notifications. Mirrors
 * the backend adapters (backend/src/services/notify/chat/*.js) field-for-
 * field. `secret: true` fields are write-only: the API returns `{ set }` for
 * them and keeps the stored value when the field is left blank on edit —
 * exactly like the audit sinks (./auditSinks/sinkTypes.js).
 *
 * One entry per *variant* rather than per platform, because Slack has two
 * genuinely different configurations (an incoming webhook vs. a bot token)
 * with different fields and different capabilities. `mode` is `null` for the
 * three platforms that only have one.
 *
 * Field: { key, label, kind: 'text' | 'password', required?, secret?, help?,
 *          placeholder? }
 */

export const SEVERITIES = ['info', 'notice', 'warning', 'critical'];

export const CHAT_VARIANTS = [
  {
    key: 'slack_webhook',
    platform: 'slack',
    mode: 'webhook',
    label: 'Slack — Incoming webhook',
    icon: Hash,
    description: 'Posts to one channel. No buttons, no direct messages.',
    actionNote: 'Cannot carry approve/deny buttons or send direct messages — only a Slack app (bot token) can. This is a platform limit, not a missing feature.',
    canAct: false,
    supportsDirectMessages: false,
    fields: [
      {
        key: 'url',
        label: 'Webhook URL',
        kind: 'password',
        secret: true,
        required: true,
        help: 'An incoming webhook URL from https://hooks.slack.com/services/… — anyone holding it can post as Shellius, so it is treated like a password.',
      },
    ],
  },
  {
    key: 'slack_app',
    platform: 'slack',
    mode: 'app',
    label: 'Slack — App (bot token)',
    icon: Bot,
    description: 'Can carry approve/deny buttons and send direct messages.',
    actionNote: 'The only chat platform that can carry approve/deny buttons or send a direct message.',
    canAct: true,
    supportsDirectMessages: true,
    fields: [
      {
        key: 'botToken',
        label: 'Bot token',
        kind: 'password',
        secret: true,
        required: true,
        placeholder: 'xoxb-…',
        help: 'Starts with xoxb-. Needs the chat:write scope; im:write and users:read are needed for direct messages.',
      },
      {
        key: 'channel',
        label: 'Channel',
        kind: 'text',
        required: true,
        placeholder: '#security or a channel ID',
      },
      {
        key: 'signingSecret',
        label: 'Signing secret',
        kind: 'password',
        secret: true,
        required: true,
        help: 'Lets Shellius verify that an approve/deny button press really came from Slack.',
      },
      {
        key: 'workspaceId',
        label: 'Workspace ID',
        kind: 'text',
        required: false,
        help: 'Optional.',
      },
    ],
  },
  {
    key: 'google_chat',
    platform: 'google_chat',
    mode: null,
    label: 'Google Chat',
    icon: MessageSquare,
    description: 'A one-way webhook into a Google Chat space.',
    actionNote: 'One-way by design — a Google Chat webhook cannot receive a button press back, so it never carries approve/deny. Platform limit, not a missing feature.',
    canAct: false,
    supportsDirectMessages: false,
    fields: [
      {
        key: 'url',
        label: 'Webhook URL',
        kind: 'password',
        secret: true,
        required: true,
        help: 'A webhook URL from a Google Chat space (chat.googleapis.com) — anyone holding it can post as Shellius, so it is treated like a password.',
      },
    ],
  },
  {
    key: 'teams',
    platform: 'teams',
    mode: null,
    label: 'Microsoft Teams',
    icon: MessagesSquare,
    description: 'Posts as the Flow bot via a Power Automate workflow.',
    actionNote: 'A workflow webhook posts as the Flow bot and has no interaction callback, so it never carries approve/deny — only a link back to Shellius. Platform limit, not a missing feature.',
    canAct: false,
    supportsDirectMessages: false,
    fields: [
      {
        key: 'url',
        label: 'Workflow URL',
        kind: 'password',
        secret: true,
        required: true,
        help: 'A Power Automate Workflows URL (logic.azure.com). Office 365 connector URLs were retired in May 2026 and are rejected. Anyone holding this URL can post as Shellius, so it is treated like a password.',
      },
    ],
  },
  {
    key: 'webhook',
    platform: 'webhook',
    mode: null,
    label: 'Webhook (JSON)',
    icon: Webhook,
    description: 'Plain JSON POST for Discord, Mattermost, Rocket.Chat or your own endpoint.',
    actionNote: 'No buttons, no direct messages — just a JSON POST.',
    canAct: false,
    supportsDirectMessages: false,
    fields: [
      {
        key: 'url',
        label: 'URL',
        kind: 'text',
        required: true,
        help: 'Plain JSON POST for Discord, Mattermost, Rocket.Chat or your own endpoint. Signed `t=…,v1=…` when a signing secret is set.',
      },
      {
        key: 'signingSecret',
        label: 'Signing secret',
        kind: 'password',
        secret: true,
        required: false,
        help: 'Optional — lets the receiver verify a message really came from Shellius.',
      },
    ],
  },
];

export function getVariant(key) {
  return CHAT_VARIANTS.find((v) => v.key === key) || null;
}

/** Every variant offered for a given platform (one for most, two for Slack). */
export function variantsForPlatform(platform) {
  return CHAT_VARIANTS.filter((v) => v.platform === platform);
}

/** The variant that matches a saved destination's platform + mode. */
export function variantFor(platform, mode) {
  return (
    CHAT_VARIANTS.find((v) => v.platform === platform && (v.mode ?? null) === (mode ?? null)) ||
    CHAT_VARIANTS.find((v) => v.platform === platform) ||
    null
  );
}

// ---------------------------------------------------------------------------
// Severity
// ---------------------------------------------------------------------------

export function severityRank(s) {
  const i = SEVERITIES.indexOf(s);
  return i === -1 ? 0 : i;
}

export function severityLabel(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : '';
}

const SEVERITY_TONE = { info: 'neutral', notice: 'info', warning: 'warning', critical: 'danger' };

export function severityTone(s) {
  return SEVERITY_TONE[s] || 'neutral';
}

// ---------------------------------------------------------------------------
// Status + health — how the list badges a destination.
// ---------------------------------------------------------------------------

/**
 * A destination's headline state, worst first: disabled after repeated
 * failure, then simply off, then failing but still retrying, then healthy.
 * `disabledReason` always wins — mirrors sinkStatus() in ./auditSinks/sinkTypes.js.
 */
export function chatDestinationStatus(dest) {
  if (!dest) return { tone: 'neutral', label: 'Unknown' };
  if (dest.disabledReason) return { tone: 'danger', label: 'Disabled' };
  if (!dest.isActive) return { tone: 'neutral', label: 'Off' };
  if (dest.consecutiveFailures > 0) {
    return { tone: 'warning', label: `Failing (${dest.consecutiveFailures}×)` };
  }
  return { tone: 'success', label: 'Active' };
}

/** Is a destination currently backing off (still active, not yet disabled)? */
export function isBackingOff(dest, now = Date.now()) {
  if (!dest?.backoffUntil) return false;
  const t = new Date(dest.backoffUntil).getTime();
  return Number.isFinite(t) && t > now;
}

/** Delivery.status ('queued' | 'delivered' | 'failed' | 'dropped') → badge tone + label. */
export function chatDeliveryStatusBadge(status) {
  if (status === 'delivered') return { tone: 'success', label: 'Delivered' };
  if (status === 'failed') return { tone: 'danger', label: 'Failed' };
  if (status === 'queued') return { tone: 'info', label: 'Queued' };
  if (status === 'dropped') return { tone: 'neutral', label: 'Dropped' };
  return { tone: 'neutral', label: status || 'Unknown' };
}

// ---------------------------------------------------------------------------
// Customer scope — deny by default, the opposite of `events`.
// ---------------------------------------------------------------------------

/**
 * One line for a destination's customer scope. Empty `customerIds` does NOT
 * mean "every customer" — it means only events tied to no customer at all
 * (see matches() in backend/src/services/notify/chatDestinationService.js).
 * An MSP has to pick customers explicitly or the channel stays quiet for
 * every one of them.
 */
export function customerScopeSummary(customerIds) {
  const n = (customerIds || []).length;
  if (n === 0) return 'No customers selected — only org-wide events (nothing tied to a customer) are sent';
  return `${n} customer${n === 1 ? '' : 's'} selected`;
}

export const CUSTOMER_SCOPE_WARNING =
  "This is the opposite of Events below: leaving it empty does not mean every customer, it means none — only events with no customer at all reach this destination. An MSP must add its customers explicitly, or the channel stays quiet for all of them.";

// ---------------------------------------------------------------------------
// Events — empty means the defaults, not everything and not silence.
// ---------------------------------------------------------------------------

export function defaultEventKeys(events = []) {
  return (events || []).filter((e) => e.chatDefault).map((e) => e.key);
}

/**
 * Describes what a destination actually receives when `selectedKeys` is
 * whatever is currently configured (or being edited). An empty selection
 * uses the default event set, not "everything" and not "nothing".
 */
export function eventsSummary(selectedKeys, allEvents = []) {
  if (!selectedKeys || selectedKeys.length === 0) {
    const defaultKeys = defaultEventKeys(allEvents);
    const labels = allEvents.filter((e) => defaultKeys.includes(e.key)).map((e) => e.label);
    return {
      usingDefaults: true,
      keys: defaultKeys,
      text: labels.length ? `Using the defaults: ${labels.join(', ')}` : 'Using the defaults',
    };
  }
  return {
    usingDefaults: false,
    keys: selectedKeys,
    text: `${selectedKeys.length} event${selectedKeys.length === 1 ? '' : 's'} selected`,
  };
}

export default {
  SEVERITIES,
  CHAT_VARIANTS,
  getVariant,
  variantsForPlatform,
  variantFor,
  severityRank,
  severityLabel,
  severityTone,
  chatDestinationStatus,
  isBackingOff,
  chatDeliveryStatusBadge,
  customerScopeSummary,
  CUSTOMER_SCOPE_WARNING,
  defaultEventKeys,
  eventsSummary,
};
