/**
 * The catalogue of things Shellius tells people about.
 *
 * Modelled on config/permissions.js, and for the same reason: the set of
 * events needs one definition that the service layer, the settings UI and the
 * documentation all read, rather than three lists that drift.
 *
 * Two fields decide where an event may go.
 *
 * `chatSafe` — whether this event may be sent to a chat destination at all.
 * A chat channel is a MULTI-READER destination; email is not. Six of the
 * things Shellius sends by email are bearer credentials — an invite, a
 * password reset, an email verification, an approval link, an SSO link
 * approval and an MFA code — and each of them grants an action as one named
 * person. None of those reaches this catalogue today, because none of them
 * writes an in-app notification, but `chatSafe: false` states the rule so
 * that adding one later is a decision rather than an accident.
 *
 * `chatDefault` — whether a destination configured with "everything" gets it.
 * A channel wants to hear that a request needs review, not that one person's
 * own access expired; the latter is still selectable, just not implied.
 *
 * Note what is deliberately NOT here: any automatic serialisation of a
 * notification's `metadata`. Chat payloads are built from an explicit
 * `chat.fields` list supplied at the call site, so a field added to metadata
 * later — a token, a signed URL, a password — cannot silently start being
 * posted into a channel. See services/notify/notifyService.js.
 */

/** Ordering for `minSeverity` filters on a destination. */
export const SEVERITIES = ['info', 'notice', 'warning', 'critical'];

export const severityRank = (s) => {
  const i = SEVERITIES.indexOf(s);
  return i === -1 ? 0 : i;
};

const EVENTS = [
  // ---- access requests ----------------------------------------------------
  {
    key: 'access_request.submitted',
    label: 'Access request submitted',
    description: 'Somebody has asked for access and needs a reviewer.',
    type: 'ACCESS_REQUEST_SUBMITTED',
    severity: 'notice',
    chatSafe: true,
    chatDefault: true,
  },
  {
    key: 'access_request.approved',
    label: 'Access request approved',
    description: 'A request was approved. Sent to the requester.',
    type: 'ACCESS_REQUEST_APPROVED',
    severity: 'info',
    chatSafe: true,
    chatDefault: false,
  },
  {
    key: 'access_request.auto_approved',
    label: 'Access request auto-approved',
    description: 'A policy approved a request without review.',
    type: 'ACCESS_REQUEST_APPROVED',
    severity: 'info',
    chatSafe: true,
    chatDefault: false,
  },
  {
    key: 'access_request.prod_bypass',
    label: 'Production approval bypassed',
    description:
      'Somebody whose role may skip production review took production access. The approvers are told after the fact.',
    type: 'ACCESS_REQUEST_APPROVED',
    severity: 'warning',
    chatSafe: true,
    chatDefault: true,
  },
  {
    key: 'access_request.denied',
    label: 'Access request denied',
    type: 'ACCESS_REQUEST_DENIED',
    severity: 'info',
    chatSafe: true,
    chatDefault: false,
  },
  {
    key: 'access_request.revoked',
    label: 'Access revoked',
    type: 'ACCESS_REQUEST_REVOKED',
    severity: 'notice',
    chatSafe: true,
    chatDefault: false,
  },
  {
    key: 'access_request.expiring',
    label: 'Access expiring soon',
    type: 'ACCESS_REQUEST_EXPIRING',
    severity: 'info',
    chatSafe: true,
    chatDefault: false,
  },
  {
    key: 'access_request.expired',
    label: 'Access expired',
    type: 'ACCESS_REQUEST_EXPIRED',
    severity: 'info',
    chatSafe: true,
    chatDefault: false,
  },
  {
    key: 'access_request.pending_expired',
    label: 'Request expired unreviewed',
    description: 'A pending request aged out because nobody reviewed it in 24 hours.',
    type: 'ACCESS_REQUEST_EXPIRED',
    severity: 'notice',
    chatSafe: true,
    chatDefault: false,
  },

  // ---- the loud ones ------------------------------------------------------
  {
    key: 'break_glass.invoked',
    label: 'Break-glass invoked',
    description: 'Emergency access was taken without review. The highest-severity event in the product.',
    type: 'BREAK_GLASS_INVOKED',
    severity: 'critical',
    chatSafe: true,
    chatDefault: true,
  },
  {
    key: 'posture.finding',
    label: 'Posture finding',
    description: 'A host exposure matched an alert rule.',
    type: 'POSTURE_FINDING',
    severity: 'warning',
    chatSafe: true,
    chatDefault: true,
  },
  {
    key: 'directory_sync.alert',
    label: 'Directory sync',
    description: 'A directory reconciliation aborted, failed, or found accounts that have left.',
    type: 'DIRECTORY_SYNC',
    severity: 'warning',
    chatSafe: true,
    chatDefault: true,
  },
];

export const NOTIFICATION_EVENTS = EVENTS.map((e) => ({
  description: '',
  chatSafe: true,
  chatDefault: false,
  ...e,
}));

export const EVENT_KEYS = NOTIFICATION_EVENTS.map((e) => e.key);

const BY_KEY = new Map(NOTIFICATION_EVENTS.map((e) => [e.key, e]));

export const getEvent = (key) => BY_KEY.get(key) ?? null;

/** Keys a chat destination may ever be configured with. */
export const CHAT_SAFE_EVENT_KEYS = NOTIFICATION_EVENTS.filter((e) => e.chatSafe).map((e) => e.key);

/** Keys a destination configured with "everything" receives. */
export const CHAT_DEFAULT_EVENT_KEYS = NOTIFICATION_EVENTS.filter((e) => e.chatSafe && e.chatDefault).map((e) => e.key);

/** `[{ key, label, description, severity, chatDefault }]` for the settings UI. */
export const describeEvents = () =>
  NOTIFICATION_EVENTS.filter((e) => e.chatSafe).map(({ key, label, description, severity, chatDefault }) => ({
    key,
    label,
    description,
    severity,
    chatDefault,
  }));

export default {
  NOTIFICATION_EVENTS,
  EVENT_KEYS,
  CHAT_SAFE_EVENT_KEYS,
  CHAT_DEFAULT_EVENT_KEYS,
  SEVERITIES,
  severityRank,
  getEvent,
  describeEvents,
};
