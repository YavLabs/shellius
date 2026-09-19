import prisma from '../config/db.js';
import ApiError from '../utils/ApiError.js';
import { encrypt } from '../utils/crypto.js';
import * as ssoConfigService from './ssoConfigService.js';
import { envAllowedDomains, callbackUrlFor, safeDefaultRole, ENV_DEFAULTS, decryptProviderSecret } from './ssoConfigService.js';
import { ssoDefaultRole, permissionsForUser } from './roleService.js';
import { PRIVILEGED_PERMISSIONS } from '../config/permissions.js';
import { passwordSignInBlocked } from './orgService.js';

// ---------------------------------------------------------------------------
// Public status — legacy (first provider) + Revision 2 (multi-provider list)
// ---------------------------------------------------------------------------

/**
 * Lightweight public probe used by the unauthenticated login page to
 * decide which SSO button(s) to render. Never returns secrets.
 * Legacy shape: { enabled, presetId } — reflects the first active provider.
 */
export async function getPublicSsoStatus(orgId) {
  const providers = await ssoConfigService.listActiveProviders(orgId);
  const first = providers[0] || null;
  return { enabled: !!first, presetId: first?.presetId || null };
}

/** Revision 2 — { enabled, presetId, providers } for login-options/public-status. */
export async function getPublicSsoSummary(orgId) {
  const providers = await ssoConfigService.listActiveProviders(orgId);
  const first = providers[0] || null;
  return { enabled: !!first, presetId: first?.presetId || null, providers };
}

// ---------------------------------------------------------------------------
// Env Google preset — lazily materialised into a real SsoConfig row (Revision 2
// §4). Documented in docs/auth-hardening.md: materialisation happens on first
// *login start* (not callback) so the provider id used throughout a given
// sign-in attempt — including its callback — is always a real DB id.
// ---------------------------------------------------------------------------

export async function materializeEnvGoogle(orgId) {
  const existing = await prisma.ssoConfig.findFirst({ where: { orgId, presetId: 'google' } });
  if (existing) return existing;

  const preset = ENV_DEFAULTS.google;
  if (!preset.clientId || !preset.clientSecret) return null;

  let created = await prisma.ssoConfig.create({
    data: {
      orgId,
      provider: 'oidc',
      presetId: 'google',
      name: 'Google',
      displayOrder: -1,
      clientId: preset.clientId,
      clientSecretEncrypted: encrypt(preset.clientSecret),
      issuerUrl: preset.issuerUrl,
      redirectUri: 'pending',
      scopes: 'openid profile email',
      defaultRole: safeDefaultRole(process.env.SSO_DEFAULT_ROLE),
      autoProvision: process.env.SSO_AUTO_PROVISION !== 'false',
      allowedDomains: envAllowedDomains(),
      requireVerifiedEmail: true,
      isActive: true,
    },
  });
  created = await prisma.ssoConfig.update({
    where: { id: created.id },
    data: { redirectUri: callbackUrlFor(created.id) },
  });
  return created;
}

/**
 * Resolve which provider row a login-start request should use:
 *   - explicit `?provider=<id>` — that row (materialising env-google on demand)
 *   - otherwise — the first active DB row, else the env-google preset
 */
export async function resolveProviderForStart(orgId, providerIdParam) {
  if (providerIdParam) {
    if (providerIdParam === 'env-google') return materializeEnvGoogle(orgId);
    return prisma.ssoConfig.findFirst({ where: { id: providerIdParam, orgId } });
  }
  const row = await prisma.ssoConfig.findFirst({
    where: { orgId, isActive: true },
    orderBy: { displayOrder: 'asc' },
  });
  if (row) return row;
  return materializeEnvGoogle(orgId);
}

/** Decrypted, ready-to-use connection params for a provider row. */
export function decryptProvider(row) {
  return {
    ...row,
    clientSecret: decryptProviderSecret(row),
    allowedDomains: row.allowedDomains || [],
    allowedOrgs: row.allowedOrgs || [],
    requireVerifiedEmail: row.requireVerifiedEmail !== false,
    defaultRole: safeDefaultRole(row.defaultRole),
  };
}

// ---------------------------------------------------------------------------
// Reconciliation — turns a verified external identity into a Shellius User,
// per docs/auth-hardening.md Revision 2:
//   1. match UserIdentity(ssoConfigId, subject)
//   2. else match on email — only when email is verified (when the config
//      requires it) AND the candidate has no OTHER identity for this SAME
//      provider with a different subject (identity_conflict).
//      A match is only linked on the spot when the account has no password
//      and is not privileged. Otherwise the caller gets a `pendingLink`
//      (docs/auth-hardening.md "Linking SSO accounts"): the user must confirm
//      with the account's password (+ MFA), or — privileged accounts with no
//      password — approve from an email.
//   3. else JIT-provision if autoProvision
// allowedDomains (empty = any) gates both sign-in and provisioning.
// defaultRole can never be super_admin.
// ---------------------------------------------------------------------------

/** Error with a stable `errorCode` the callback route maps to `#error=<code>`. */
export function ssoError(code, message, statusCode = 403) {
  const err = new ApiError(statusCode, message);
  err.errorCode = code;
  return err;
}

const DISABLED_STATUSES = ['deleted', 'suspended', 'deactivated'];

/**
 * Does this user hold any privileged permission (config/permissions.js
 * PRIVILEGED_PERMISSIONS)? Derived from the role's permissions, never from
 * the role name.
 */
export async function isPrivilegedUser(user) {
  const assignedRole =
    user.assignedRole !== undefined
      ? user.assignedRole
      : user.roleId
        ? await prisma.role.findFirst({ where: { id: user.roleId, orgId: user.orgId } })
        : null;
  const perms = new Set(permissionsForUser({ ...user, assignedRole }));
  return PRIVILEGED_PERMISSIONS.some((p) => perms.has(p));
}

/**
 * How an email-matched account must confirm a new SSO link:
 *   'password'        — it has a password: re-enter it (+ MFA if enrolled)
 *   'email_approval'  — no password but privileged: approve from an email
 *   null              — no password, not privileged: link now (as before)
 */
export async function linkConfirmationFor(user) {
  if (user.passwordHash) return 'password';
  if (await isPrivilegedUser(user)) return 'email_approval';
  return null;
}

/**
 * Create the UserIdentity row linking (cfg, subject) to `userId`. Used by the
 * confirmed / email-approved / profile-connect paths (the automatic sign-in
 * path upserts inline in reconcileSsoUser).
 *
 * Throws ssoError('identity_in_use') when the (provider, subject) already
 * belongs to a different user, and ssoError('already_connected') when this
 * user already has an identity for this provider. Returns the identity row.
 */
export async function linkIdentityToUser({ orgId, cfg, userId, subject, email, name, picture, activate = false }) {
  const label = cfg.name || cfg.provider;
  const existing = await prisma.userIdentity.findUnique({
    where: { ssoConfigId_subject: { ssoConfigId: cfg.id, subject } },
  });
  if (existing && existing.userId !== userId) {
    throw ssoError('identity_in_use', `This ${label} account is already linked to another Shellius user`, 409);
  }
  if (existing) {
    throw ssoError('already_connected', `This ${label} account is already connected`, 409);
  }
  const sameProvider = await prisma.userIdentity.findFirst({ where: { userId, ssoConfigId: cfg.id } });
  if (sameProvider) {
    throw ssoError('already_connected', `You already have a ${label} account connected`, 409);
  }

  const user = await prisma.user.findFirst({ where: { id: userId, orgId } });
  if (!user || DISABLED_STATUSES.includes(user.status)) {
    throw ssoError('account_disabled', 'Account is not active');
  }

  let identity;
  try {
    identity = await prisma.userIdentity.create({
      data: {
        orgId,
        userId,
        ssoConfigId: cfg.id,
        provider: cfg.provider,
        subject,
        email: email || null,
        lastLoginAt: activate ? new Date() : null,
      },
    });
  } catch (err) {
    // Lost a race with another link of the same (provider, subject).
    if (err.code === 'P2002') {
      throw ssoError('identity_in_use', `This ${label} account is already linked to another Shellius user`, 409);
    }
    throw err;
  }

  await prisma.user.update({
    where: { id: userId },
    data: {
      name: user.name || name || user.name,
      avatarUrl: user.avatarUrl || picture || null,
      ssoProvider: user.ssoProvider || cfg.provider,
      ssoSub: user.ssoSub || subject,
      // A confirmed link for an invited / unverified account activates it,
      // matching the automatic sign-in path.
      ...(activate && ['invited', 'pending_verification'].includes(user.status) ? { status: 'active' } : {}),
    },
  });
  return identity;
}

/**
 * @param {object} params
 * @param {string} params.orgId
 * @param {object} params.cfg - decrypted provider row (has `id`, `provider`, allowedDomains, etc.)
 * @param {string} params.subject - OIDC sub / GitHub numeric user id (as a string)
 * @param {string} [params.email]
 * @param {boolean} [params.emailVerified]
 * @param {string} [params.name]
 * @param {string} [params.picture]
 * @returns {Promise<object>} the signed-in User (with `organization`), carrying
 *   `ssoLinkedVia: 'auto'` when this sign-in newly linked the identity by
 *   email; or `{ pendingLink }` when the link must be confirmed first.
 */
export async function reconcileSsoUser({ orgId, cfg, subject, email, emailVerified, name, picture }) {
  if (!subject) {
    throw ssoError('sso_failed', `${cfg.provider} response is missing a subject/sub claim`);
  }
  email = email ? String(email).toLowerCase().trim() : '';
  const requireVerified = cfg.requireVerifiedEmail !== false;

  const allowedDomains = cfg.allowedDomains || [];
  if (allowedDomains.length > 0) {
    const domain = email.split('@')[1]?.toLowerCase();
    if (!domain || !allowedDomains.includes(domain)) {
      throw ssoError('domain_not_allowed', 'Your email domain is not permitted to sign in to this organization');
    }
  }

  // 1. Match on (ssoConfigId, subject) — the strongest, most stable identity.
  let user = null;
  let linkedVia = null;
  const existingIdentity = await prisma.userIdentity.findUnique({
    where: { ssoConfigId_subject: { ssoConfigId: cfg.id, subject } },
  });
  if (existingIdentity) {
    user = await prisma.user.findUnique({ where: { id: existingIdentity.userId } });
  }

  // 2. Fall back to matching an existing local/invited account by email.
  if (!user && email) {
    const candidate = await prisma.user.findFirst({ where: { orgId, email } });
    if (candidate) {
      // This SAME provider already has a (different-subject) identity linked
      // to this user — refuse to silently re-link under a new subject.
      const conflictingIdentity = await prisma.userIdentity.findFirst({
        where: { userId: candidate.id, ssoConfigId: cfg.id, subject: { not: subject } },
      });
      if (conflictingIdentity) {
        throw ssoError('identity_conflict', 'This email is already linked to a different identity provider account');
      }
      if (requireVerified && !emailVerified) {
        throw ssoError('email_not_verified', 'Your identity provider did not assert a verified email for this account');
      }
      if (DISABLED_STATUSES.includes(candidate.status)) {
        throw ssoError('account_disabled', 'Account is not active');
      }
      // Never link silently to an account that has a password (any role), or
      // to a privileged SSO-only account — hand back a pending link instead.
      const mode = await linkConfirmationFor(candidate);
      if (mode) {
        return {
          pendingLink: {
            mode,
            userId: candidate.id,
            orgId,
            userEmail: candidate.email,
            userName: candidate.name,
            ssoConfigId: cfg.id,
            provider: cfg.provider,
            providerName: cfg.name || cfg.provider,
            presetId: cfg.presetId || null,
            subject,
            email,
            name: name || null,
            picture: picture || null,
          },
        };
      }
      user = candidate;
      linkedVia = 'auto';
    }
  }

  if (!user) {
    if (!cfg.autoProvision) {
      throw ssoError(
        'provisioning_disabled',
        'Your account has not been set up in Shellius yet. Please contact your administrator to request access.'
      );
    }
    if (!email) {
      throw ssoError('sso_failed', `${cfg.provider} response is missing an email`);
    }
    if (requireVerified && !emailVerified) {
      throw ssoError('email_not_verified', 'Your identity provider did not assert a verified email for this account');
    }
    const defaultRole = await ssoDefaultRole(orgId, cfg.defaultRole);
    user = await prisma.user.create({
      data: {
        orgId,
        email,
        name: name || email,
        role: defaultRole.baseRole,
        roleId: defaultRole.id,
        status: 'active',
        ssoProvider: cfg.provider,
        ssoSub: subject,
        avatarUrl: picture || null,
      },
    });
    if (cfg.defaultGroupId) {
      await prisma.groupMembership
        .create({ data: { groupId: cfg.defaultGroupId, userId: user.id } })
        .catch(() => {}); // ignore if group was deleted / already a member
    }
  } else {
    if (['deleted', 'suspended', 'deactivated'].includes(user.status)) {
      throw ssoError('account_disabled', 'Account is not active');
    }
    const nextAvatar = picture && !(user.avatarUrl || '').startsWith('data:') ? picture : user.avatarUrl;
    user = await prisma.user.update({
      where: { id: user.id },
      data: {
        name: user.name || name || user.name,
        avatarUrl: nextAvatar,
        // Legacy single-provider fields — only backfilled when unset, so an
        // account already linked to a different provider keeps its original
        // "primary" legacy provider/sub for any code still reading them.
        ssoProvider: user.ssoProvider || cfg.provider,
        ssoSub: user.ssoSub || subject,
        // First SSO sign-in for an invited/pending user activates the
        // account. Safe here: the disabled-status branch above already
        // rejected suspended/deactivated/deleted accounts.
        status: 'active',
        lastLoginAt: new Date(),
      },
    });
  }

  // Upsert the UserIdentity row for THIS provider.
  await prisma.userIdentity.upsert({
    where: { ssoConfigId_subject: { ssoConfigId: cfg.id, subject } },
    update: { userId: user.id, email: email || null, lastLoginAt: new Date() },
    create: {
      orgId,
      userId: user.id,
      ssoConfigId: cfg.id,
      provider: cfg.provider,
      subject,
      email: email || null,
      lastLoginAt: new Date(),
    },
  });

  // Always return the user WITH organization included — issueSession()/mfaGate()
  // expect it.
  const full = await prisma.user.findUnique({ where: { id: user.id }, include: { organization: true } });
  if (linkedVia) full.ssoLinkedVia = linkedVia;
  return full;
}

/** `GET /api/auth/me` → `identities`: one row per linked provider. */
export async function listUserIdentities(userId, orgId = null) {
  const rows = await prisma.userIdentity.findMany({
    where: { userId, ...(orgId ? { orgId } : {}) },
    include: { ssoConfig: { select: { name: true, presetId: true } } },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map((r) => ({
    id: r.id,
    providerId: r.ssoConfigId,
    provider: r.provider,
    providerName: r.ssoConfig?.name || r.provider,
    presetId: r.ssoConfig?.presetId || null,
    email: r.email,
    lastLoginAt: r.lastLoginAt,
    createdAt: r.createdAt,
  }));
}

/**
 * DELETE /api/auth/identities/:id — unlink. Refused (409 LAST_SIGN_IN_METHOD)
 * if it would leave the user with no password and no other identity.
 */
export async function deleteUserIdentity(userId, identityId, { orgId = null, byAdmin = false } = {}) {
  const identity = await prisma.userIdentity.findFirst({
    where: { id: identityId, userId, ...(orgId ? { orgId } : {}) },
    include: { ssoConfig: { select: { name: true } } },
  });
  if (!identity) throw new ApiError(404, 'Identity not found');

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, orgId: true, role: true, roleId: true, passwordHash: true },
  });
  // A password only counts as a way in if the org lets this user use it
  // (Organization.settings.access.ssoRequired exempts settings.sso holders).
  const passwordUsable = !!user?.passwordHash && !(await passwordSignInBlocked(user));
  if (!passwordUsable) {
    const otherCount = await prisma.userIdentity.count({ where: { userId, id: { not: identityId } } });
    if (otherCount === 0) {
      throw new ApiError(
        409,
        byAdmin
          ? 'Removing this identity would leave the user with no way to sign in'
          : 'Removing this identity would leave you with no way to sign in',
        { code: 'LAST_SIGN_IN_METHOD' }
      );
    }
  }

  await prisma.userIdentity.delete({ where: { id: identityId } });
  return {
    deleted: true,
    identity: {
      id: identity.id,
      providerId: identity.ssoConfigId,
      providerName: identity.ssoConfig?.name || identity.provider,
      email: identity.email,
    },
  };
}

export default {
  getPublicSsoStatus,
  getPublicSsoSummary,
  materializeEnvGoogle,
  resolveProviderForStart,
  decryptProvider,
  reconcileSsoUser,
  ssoError,
  isPrivilegedUser,
  linkConfirmationFor,
  linkIdentityToUser,
  listUserIdentities,
  deleteUserIdentity,
};
