import { Building2, Shield, Cloud, Github } from 'lucide-react';

/**
 * Directory sync adapter catalogue + pure status/formatting helpers for
 * Settings → Single sign-on → Directory sync. Mirrors
 * `../../auditSinks/sinkTypes.js`: the field shapes here match the backend
 * adapters (`backend/src/services/directorySync/adapters/*.js`) field for
 * field. `secret: true` fields are write-only — the API returns `{ set }`
 * for them and keeps the stored value when the field is left blank on
 * update, exactly like audit sinks and email providers.
 *
 * Kept dependency-free of React/services so it can be unit tested directly
 * (adapterTypes.test.js) — the components import everything from here
 * instead of duplicating this logic inline.
 *
 * Field: { key, label, kind: 'text'|'password'|'textarea'|'number', placeholder?,
 *          required?, secret?, help? }
 */

export const ADAPTER_TYPES = [
  {
    type: 'entra',
    label: 'Microsoft Entra ID',
    icon: Building2,
    help: 'An app registration with the application permission User.Read.All, admin-consented.',
    fields: [
      { key: 'tenantId', label: 'Tenant ID', kind: 'text', required: true, placeholder: '00000000-0000-0000-0000-000000000000' },
      { key: 'clientId', label: 'Client ID', kind: 'text', required: true, placeholder: '00000000-0000-0000-0000-000000000000' },
      { key: 'clientSecret', label: 'Client secret', kind: 'password', secret: true, required: true },
    ],
  },
  {
    type: 'okta',
    label: 'Okta',
    icon: Shield,
    help: 'A read-only admin API token.',
    fields: [
      { key: 'domain', label: 'Domain', kind: 'text', required: true, placeholder: 'acme.okta.com' },
      { key: 'apiToken', label: 'API token', kind: 'password', secret: true, required: true },
    ],
  },
  {
    type: 'google',
    label: 'Google Workspace',
    icon: Cloud,
    help:
      'A service account with domain-wide delegation for admin.directory.user.readonly. Admin email is the admin to impersonate and is required.',
    fields: [
      { key: 'clientEmail', label: 'Service account email', kind: 'text', required: true, placeholder: 'sync@project.iam.gserviceaccount.com' },
      { key: 'adminEmail', label: 'Admin email to impersonate', kind: 'text', required: true, placeholder: 'admin@acme.com' },
      { key: 'privateKey', label: 'Private key (PEM)', kind: 'textarea', secret: true, required: true, placeholder: '-----BEGIN PRIVATE KEY-----' },
      { key: 'customer', label: 'Customer ID', kind: 'text', placeholder: 'my_customer', help: 'Defaults to my_customer.' },
    ],
  },
  {
    type: 'github',
    label: 'GitHub',
    icon: Github,
    help: 'Needs the read:org scope.',
    fields: [
      { key: 'org', label: 'Organization', kind: 'text', required: true, placeholder: 'acme-corp' },
      { key: 'token', label: 'Token', kind: 'password', secret: true, required: true },
    ],
  },
];

export function getAdapterType(type) {
  return ADAPTER_TYPES.find((t) => t.type === type) || null;
}

// ---------------------------------------------------------------------------
// Config form values <-> stored config (secrets are never populated back)
// ---------------------------------------------------------------------------

/** Config → form field values. Secret fields always start blank — "Stored" is shown separately from `config[key].set`. */
export function valuesFromConfig(def, config) {
  const next = {};
  for (const f of def?.fields || []) {
    if (f.secret) {
      next[f.key] = '';
      continue;
    }
    next[f.key] = config?.[f.key] ?? '';
  }
  return next;
}

/**
 * Required fields still missing from `values`, given whether we're editing
 * (in which case an already-stored secret counts as present even though its
 * form value is blank).
 */
export function missingRequiredFields(def, values, { isEdit = false, storedConfig = null } = {}) {
  const missing = [];
  for (const f of def?.fields || []) {
    if (!f.required) continue;
    if (f.secret && isEdit && storedConfig?.[f.key]?.set) continue;
    const v = values?.[f.key];
    if (v === undefined || v === null || String(v).trim() === '') missing.push(f);
  }
  return missing;
}

// ---------------------------------------------------------------------------
// Sync settings shared by every adapter
// ---------------------------------------------------------------------------

export const ACTION_OPTIONS = [
  { value: 'flag', label: 'Flag only', help: 'Creates a finding for a human to review. Never suspends anyone by itself.' },
  { value: 'suspend', label: 'Suspend automatically', help: 'Suspends matching accounts directly, subject to the safety limits below.' },
];

export function actionHelp(action) {
  return ACTION_OPTIONS.find((o) => o.value === action)?.help || '';
}

/** The three safety brakes, each with the one-line explanation the UI shows next to it. */
export const SAFETY_LIMIT_FIELDS = [
  {
    key: 'maxSuspendPercent',
    label: 'Max suspend percent',
    unit: '%',
    help: 'Refuses to suspend more than this share of matched users in a single run.',
  },
  {
    key: 'maxSuspendCount',
    label: 'Max suspend count',
    unit: '',
    help: 'Refuses to suspend more than this many users in a single run, regardless of percentage.',
  },
  {
    key: 'graceHours',
    label: 'Grace period',
    unit: 'h',
    help: 'Waits this long after an account first looks missing or disabled before acting on it, so a brief directory hiccup is not treated as a deprovision.',
  },
];

// ---------------------------------------------------------------------------
// Armed vs dry run — the central safety predicate of this feature
// ---------------------------------------------------------------------------

/**
 * True once a config would actually suspend real accounts if it ran:
 * dry run is off AND the action is 'suspend'. Everywhere else in the UI —
 * flag-only, or dry run on — is a safe, non-destructive state. Accepts a
 * plain { dryRun, action } so it works on a sync row or an in-progress form.
 */
export function isArmed({ dryRun, action } = {}) {
  return dryRun === false && action === 'suspend';
}

/** The exact "dry run" state label used throughout the UI. */
export function dryRunLabel({ dryRun, action } = {}) {
  if (dryRun) return 'Dry run — reports only, changes nothing';
  if (action === 'suspend') return 'Armed — matching accounts can be suspended automatically';
  return 'Live — findings are created for review, no accounts are suspended';
}

/** Badge for a sync row's current mode (dry run / armed / flag only). */
export function modeBadge(sync) {
  if (!sync) return { tone: 'neutral', label: 'Not configured' };
  if (sync.dryRun) return { tone: 'info', label: 'Dry run' };
  if (sync.action === 'suspend') return { tone: 'warning', label: 'Armed' };
  return { tone: 'neutral', label: 'Flag only' };
}

/** Badge for a sync row's on/off state. */
export function activeBadge(sync) {
  if (!sync) return { tone: 'neutral', label: 'Not configured' };
  return sync.isActive ? { tone: 'success', label: 'Active' } : { tone: 'neutral', label: 'Off' };
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

/**
 * Run.status → badge. `aborted` is deliberately styled as a caution
 * (the feature refusing to act), never as `failed` (the feature erroring) —
 * that distinction is the whole point of the aborted state.
 */
export function runStatusBadge(status) {
  if (status === 'ok') return { tone: 'success', label: 'Ok' };
  if (status === 'aborted') return { tone: 'warning', label: 'Aborted' };
  if (status === 'failed') return { tone: 'danger', label: 'Failed' };
  if (status === 'running') return { tone: 'info', label: 'Running' };
  return { tone: 'neutral', label: status || 'Unknown' };
}

/**
 * Whether a run's identity matching is worth calling out: some accounts had
 * no known directory id (unknownIdentities > 0), or nothing matched by
 * directory id at all while email matching picked up the slack — both are
 * the Entra "sub is per-application, oid only known after sign-in" case in
 * disguise, though it can happen with any adapter.
 */
export function showIdentityCaveat(run) {
  if (!run) return false;
  if (Number(run.unknownIdentities) > 0) return true;
  return Number(run.matchedByExternalId) === 0 && Number(run.matchedByEmail) > 0;
}

/** The explanatory text for showIdentityCaveat(), adapter-specific for Entra. */
export function identityCaveatMessage(adapterType) {
  const base =
    'Some accounts have no known directory id yet and were not judged either way — they are skipped, not treated as missing.';
  if (adapterType === 'entra') {
    return `${base} For Microsoft Entra this is expected until each user signs in again: Entra's sub claim is per-application, so the directory id (the oid claim) is only learned the next time they sign in.`;
  }
  return base;
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

export function findingReasonLabel(reason) {
  if (reason === 'missing') return 'Missing from directory';
  if (reason === 'disabled') return 'Disabled in directory';
  return reason || 'Unknown';
}

/**
 * The four statuses a finding can hold, matching DirectorySyncFinding.status
 * in the schema:
 *
 *   open      still absent from the directory, not acted on (yet)
 *   resolved  they reappeared before anything was done — the good outcome
 *   acted     they were suspended and their access revoked
 *   ignored   deliberately left alone; `outcome` says why, e.g. they still
 *             have an identity with another active provider
 */
export function findingStatusBadge(status) {
  if (status === 'open') return { tone: 'warning', label: 'Open' };
  if (status === 'resolved') return { tone: 'success', label: 'Resolved' };
  if (status === 'acted') return { tone: 'danger', label: 'Deprovisioned' };
  if (status === 'ignored') return { tone: 'neutral', label: 'Left alone' };
  return { tone: 'neutral', label: status || 'Unknown' };
}

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * "since 14 Mar" from an ISO date, for "missing since 14 Mar" / "disabled
 * since 14 Mar" finding rows. Fixed "D Mon" formatting rather than
 * toLocaleDateString, whose month/day order otherwise varies by locale.
 * Returns null for a missing/invalid date so a caller can fall back to
 * nothing rather than render "since Invalid Date".
 */
export function sinceLabel(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return null;
  return `since ${d.getDate()} ${SHORT_MONTHS[d.getMonth()]}`;
}

export default {
  ADAPTER_TYPES,
  getAdapterType,
  valuesFromConfig,
  missingRequiredFields,
  ACTION_OPTIONS,
  actionHelp,
  SAFETY_LIMIT_FIELDS,
  isArmed,
  dryRunLabel,
  modeBadge,
  activeBadge,
  runStatusBadge,
  showIdentityCaveat,
  identityCaveatMessage,
  findingReasonLabel,
  findingStatusBadge,
  sinceLabel,
};
