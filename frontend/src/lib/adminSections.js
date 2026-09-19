import {
  Users,
  ShieldCheck,
  UsersRound,
  KeyRound,
  Smartphone,
  Lock,
  Building2,
  Shield,
  Zap,
  Mail,
  HardDrive,
} from 'lucide-react';
import { canAny } from '@/lib/permissions';

/**
 * Administration sections — the single table behind the /admin page, its
 * left-hand nav, the profile menu entry, the command palette entries and
 * the redirects from the old /settings, /users, /roles and /groups URLs.
 *
 * Pure data + functions only (no React components) so it can be unit tested
 * and imported by lib/commands.js without pulling in page code. The page
 * (pages/Administration.jsx) maps `key` to the component it renders.
 *
 * Every section is gated by permissions (`anyOf`), never by role names.
 */

export const ADMIN_BASE = '/admin';

export const ADMIN_GROUPS = [
  { key: 'people', label: 'People & access' },
  { key: 'authentication', label: 'Authentication' },
  { key: 'organization', label: 'Organization' },
  { key: 'integrations', label: 'Integrations' },
];

export const ADMIN_SECTIONS = [
  {
    key: 'users',
    group: 'people',
    label: 'Users',
    icon: Users,
    anyOf: ['users.view'],
    detail: true,
    keywords: ['people', 'accounts', 'members', 'invite', 'team', 'password reset', 'suspend'],
  },
  {
    key: 'roles',
    group: 'people',
    label: 'Roles',
    icon: ShieldCheck,
    anyOf: ['roles.view'],
    detail: true,
    keywords: ['permissions', 'rbac', 'role', 'admin', 'manager', 'member', 'custom role', 'matrix'],
  },
  {
    key: 'groups',
    group: 'people',
    label: 'Groups',
    icon: UsersRound,
    anyOf: ['groups.view'],
    detail: true,
    keywords: ['teams', 'membership', 'group'],
  },
  {
    key: 'sso',
    group: 'authentication',
    label: 'Single sign-on',
    icon: KeyRound,
    anyOf: ['settings.sso'],
    keywords: ['sso', 'okta', 'google', 'oidc', 'saml', 'github', 'entra', 'azure ad', 'auth0', 'identity provider', 'idp', 'login'],
  },
  {
    key: 'mfa',
    group: 'authentication',
    label: 'Two-factor',
    icon: Smartphone,
    anyOf: ['settings.mfa'],
    keywords: ['mfa', '2fa', 'totp', 'two-factor', 'authenticator', 'otp', 'one-time code'],
  },
  {
    key: 'access',
    group: 'authentication',
    label: 'Access rules',
    icon: Lock,
    anyOf: ['org.access_settings'],
    keywords: ['production', 'prod', 'approval', 'bypass', 'require sso', 'personal vault'],
  },
  {
    key: 'organization',
    group: 'organization',
    label: 'General',
    icon: Building2,
    anyOf: ['org.update'],
    keywords: ['organization', 'org', 'name', 'domain', 'logo', 'company'],
  },
  {
    key: 'ca',
    group: 'organization',
    label: 'Certificate authority',
    icon: Shield,
    anyOf: ['ca.view'],
    keywords: ['ca', 'certificate', 'ssh ca', 'rotate', 'fingerprint', 'public key'],
  },
  {
    key: 'quick-connect',
    group: 'organization',
    label: 'Quick Connect',
    icon: Zap,
    anyOf: ['quick_connect.settings'],
    keywords: ['quick connect', 'ad-hoc', 'adhoc', 'ssh'],
  },
  {
    key: 'email',
    group: 'integrations',
    label: 'Email',
    icon: Mail,
    anyOf: ['settings.smtp'],
    keywords: ['email', 'smtp', 'mail', 'sendgrid', 'mailgun', 'postmark', 'resend', 'gmail', 'microsoft 365', 'office 365', 'outlook'],
  },
  {
    key: 'storage',
    group: 'integrations',
    label: 'Storage',
    icon: HardDrive,
    anyOf: ['settings.storage'],
    keywords: ['storage', 's3', 'minio', 'azure blob', 'bucket', 'recordings'],
  },
];

const BY_KEY = new Map(ADMIN_SECTIONS.map((s) => [s.key, s]));

/** Every permission that opens at least one section (ROUTE_ACCESS['/admin']). */
export const ADMIN_PERMISSIONS = [...new Set(ADMIN_SECTIONS.flatMap((s) => s.anyOf))];

export function getSection(key) {
  return BY_KEY.get(key) || null;
}

export function sectionPath(key) {
  return `${ADMIN_BASE}/${key}`;
}

export function canSeeSection(user, section) {
  const s = typeof section === 'string' ? getSection(section) : section;
  return !!s && canAny(user, ...s.anyOf);
}

/** Sections the viewer may open, in nav order. */
export function visibleSections(user) {
  return ADMIN_SECTIONS.filter((s) => canSeeSection(user, s));
}

export function canSeeAdministration(user) {
  return visibleSections(user).length > 0;
}

/**
 * The section key in an /admin path ('/admin/roles/abc' → 'roles'), or null
 * for '/admin' itself or a path outside Administration.
 */
export function sectionKeyFromPath(pathname) {
  const parts = String(pathname || '').split(/[?#]/)[0].split('/').filter(Boolean);
  if (parts[0] !== 'admin') return null;
  return parts[1] || null;
}

/**
 * Where a visit to /admin[/<key>] should go for this viewer:
 *   { redirect: '/' }             — no visible section at all (dashboard)
 *   { redirect: '/admin/<first>' } — bare /admin
 *   { redirect: '/admin' }         — unknown section, or one they can't see
 *   { section }                    — render it
 */
export function resolveAdminRoute(user, key) {
  const visible = visibleSections(user);
  if (visible.length === 0) return { redirect: '/' };
  if (!key) return { redirect: sectionPath(visible[0].key) };
  const section = visible.find((s) => s.key === key);
  if (!section) return { redirect: ADMIN_BASE };
  return { section };
}

/** Group the given sections by ADMIN_GROUPS order, dropping empty groups. */
export function groupSections(sections) {
  return ADMIN_GROUPS.map((g) => ({ ...g, sections: sections.filter((s) => s.group === g.key) })).filter(
    (g) => g.sections.length > 0
  );
}

/**
 * Does `section` match a search query? Matches the label, the group label
 * and the keywords (e.g. "smtp" → Email, "okta" → Single sign-on).
 */
export function sectionMatches(section, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return true;
  const group = ADMIN_GROUPS.find((g) => g.key === section.group);
  const haystack = [section.label, group?.label, ...(section.keywords || [])].map((t) => String(t).toLowerCase());
  return haystack.some((t) => t.includes(q));
}

export function filterSections(sections, query) {
  return sections.filter((s) => sectionMatches(s, query));
}

// ---------------------------------------------------------------------------
// Old URLs → new
// ---------------------------------------------------------------------------

/** Old Settings `?tab=` keys → Administration section keys. */
export const LEGACY_SETTINGS_TABS = {
  org: 'organization',
  organization: 'organization',
  ca: 'ca',
  sso: 'sso',
  access: 'access',
  storage: 'storage',
  mfa: 'mfa',
  quickconnect: 'quick-connect',
  'quick-connect': 'quick-connect',
  email: 'email',
  smtp: 'email',
};

const LEGACY_PAGES = ['users', 'roles', 'groups'];

/**
 * The /admin URL for an old /settings, /users, /roles or /groups URL, or
 * null when `pathname` isn't one of them. Query parameters other than
 * Settings' `tab` are kept (e.g. ?connected=1 from the Google OAuth
 * callback, ?action=invite, ?highlight=<id>).
 */
export function legacyAdminPath(pathname, search = '') {
  const parts = String(pathname || '').split('/').filter(Boolean);
  const params = new URLSearchParams(search);
  const withQuery = (path) => {
    const qs = params.toString();
    return qs ? `${path}?${qs}` : path;
  };
  if (parts[0] === 'settings' && parts.length === 1) {
    const tab = params.get('tab');
    params.delete('tab');
    const key = tab ? LEGACY_SETTINGS_TABS[tab.toLowerCase()] : null;
    return withQuery(key ? sectionPath(key) : ADMIN_BASE);
  }
  if (LEGACY_PAGES.includes(parts[0]) && parts.length <= 2) {
    return withQuery([ADMIN_BASE, ...parts].join('/'));
  }
  return null;
}
