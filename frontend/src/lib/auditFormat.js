/**
 * Human-readable audit events.
 *
 * Audit actions are dotted keys (`keystore.credential.delete`,
 * `quick_connect.ticket`, `access_request.approve`). describeAuditEvent()
 * turns one into { verb, object, target, category } so the UI can render
 * "Local Admin deleted identity prod-root" instead of the raw key.
 */

// Resource prefixes (longest match wins) → noun shown to the user.
const RESOURCES = [
  ['keystore.credential', 'identity'],
  ['keystore.key', 'SSH key'],
  ['keystore.deployment', 'key export'],
  ['quick_connect.history', 'Quick Connect history'],
  ['quick_connect.ticket', 'Quick Connect session'],
  ['quick_connect.settings', 'Quick Connect settings'],
  ['quick_connect', 'Quick Connect'],
  ['access_request', 'access request'],
  ['sso.provider', 'SSO provider'],
  ['sso', 'SSO settings'],
  ['mfa', 'MFA'],
  ['auth', 'account'],
  ['user', 'user'],
  ['group', 'group'],
  ['customer', 'customer'],
  ['server', 'server'],
  ['policy', 'policy'],
  ['certificate', 'certificate'],
  ['cert', 'certificate'],
  ['ca', 'certificate authority'],
  ['session', 'session'],
  ['org', 'organization settings'],
  ['smtp', 'email settings'],
  ['storage', 'storage settings'],
  ['import', 'bulk import'],
];

// Final action segment → past-tense verb.
const VERBS = {
  create: 'created',
  update: 'updated',
  delete: 'deleted',
  remove: 'removed',
  submit: 'requested',
  approve: 'approved',
  deny: 'denied',
  revoke: 'revoked',
  expire: 'expired',
  generate: 'generated',
  import: 'imported',
  export: 'exported',
  rotate: 'rotated',
  deploy: 'exported',
  retry: 'retried',
  test: 'tested',
  reset: 'reset',
  enable: 'enabled',
  disable: 'disabled',
  invite: 'invited',
  unlock: 'unlocked',
  terminate: 'terminated',
  provision: 'provisioned',
  attach: 'attached to',
  detach: 'detached from',
  end: 'ended',
  close: 'closed',
  reconnect: 'reconnected via',
  save: 'saved',
  clear: 'cleared',
  login: 'signed in',
  logout: 'signed out',
  login_failed: 'failed to sign in',
  account_locked: 'locked out',
  sso_login: 'signed in with SSO',
  prod_bypass: 'got direct production access',
  break_glass: 'used break-glass access',
  ticket: 'started',
};

// Actions whose sentence reads better without the resource noun.
const NO_OBJECT = new Set(['login', 'logout', 'login_failed', 'account_locked', 'sso_login']);

function resourceFor(action) {
  const match = RESOURCES.filter(([prefix]) => action === prefix || action.startsWith(`${prefix}.`))
    .sort((a, b) => b[0].length - a[0].length)[0];
  return match ? match[1] : null;
}

function humanise(s) {
  return String(s || '').replace(/[._]/g, ' ').trim();
}

/**
 * @param {{ action: string, resourceType?: string, resourceLabel?: string, metadata?: object }} item
 * @returns {{ verb: string, object: string|null, target: string|null, category: string }}
 */
export function describeAuditEvent(item) {
  const action = String(item?.action || '');
  const parts = action.split('.');
  const last = parts[parts.length - 1];
  const category = parts[0] || 'other';

  const verb = VERBS[last] || humanise(last);
  const object = NO_OBJECT.has(last)
    ? null
    : resourceFor(action) || humanise(item?.resourceType || parts.slice(0, -1).join(' ')).toLowerCase() || null;

  const meta = item?.metadata || {};
  const rawTarget =
    item?.resourceLabel ||
    meta.name ||
    meta.label ||
    meta.hostname ||
    (meta.host ? `${meta.username ? `${meta.username}@` : ''}${meta.host}` : null) ||
    meta.email ||
    null;
  // Don't repeat a target that is just the resource type ("credential", "ticket"),
  // or the actor themselves: self-events (sign in, MFA, profile) would read
  // "Local Admin signed in Local Admin".
  const actor = item?.actor || {};
  const norm = (v) => String(v || '').trim().toLowerCase();
  const isSelf =
    (item?.resourceId && item.resourceId === (actor.id || item?.actorId) && /user/i.test(item?.resourceType || '')) ||
    [actor.name, actor.email, item?.actorName, item?.actorEmail].filter(Boolean).map(norm).includes(norm(rawTarget));
  const target =
    rawTarget && !isSelf && norm(rawTarget) !== norm(item?.resourceType)
      ? String(rawTarget)
      : null;

  return { verb, object, target, category };
}

/** Plain-text sentence (for titles / tooltips). */
export function auditSentence(item) {
  const { verb, object, target } = describeAuditEvent(item);
  const actor = item?.actor?.name || item?.actorName || 'System';
  return [actor, verb, object, target].filter(Boolean).join(' ');
}

/** Short category label for badges ("Keystore", "Quick Connect", "Access request"). */
export function auditCategoryLabel(category) {
  const map = {
    keystore: 'Keystore',
    quick_connect: 'Quick Connect',
    access_request: 'Access request',
    auth: 'Sign-in',
    sso: 'SSO',
    mfa: 'MFA',
    ca: 'CA',
    cert: 'Certificate',
    certificate: 'Certificate',
    org: 'Organization',
    smtp: 'Email',
  };
  if (map[category]) return map[category];
  const s = humanise(category);
  return s.charAt(0).toUpperCase() + s.slice(1);
}
