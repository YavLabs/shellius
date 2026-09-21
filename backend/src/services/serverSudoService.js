/**
 * serverSudoService.js — a saved sudo password per server.
 *
 * A certificate install connects with no password at all, which is the point
 * of it — but a non-root SSH user still needs one for `sudo`, and the only
 * place it could come from was the person running the install, every time.
 * Reinstalling a degraded collector on twenty hosts meant typing the same
 * password twenty times, and again next week.
 *
 * The password is kept where every other stored secret in Shellius is kept:
 * the org Keystore, as an ordinary identity (username = the server's SSH
 * user, encrypted at rest, never returned by a read API), bound to the
 * server through `Server.sudoCredentialId`. That makes it visible, rotatable
 * and deletable from the Keystore like anything else, instead of a hidden
 * column only this feature knows about.
 *
 * Rules:
 *   - Org scope only. A personal vault item can never be bound to a server
 *     (CLAUDE.md), so a sudo password is never saved into one.
 *   - Saving needs `servers.manage_credentials` AND `keystore.manage` —
 *     it binds a secret to a server and creates a Keystore entry.
 *   - Using it needs `keystore.view`, via resolveCredentialForActor, exactly
 *     like using any other stored identity.
 *   - Only saved after it has been SEEN to work (the install succeeded), so
 *     the Keystore never fills with passwords that were typos.
 */

import prisma from '../config/db.js';
import ApiError from '../utils/ApiError.js';
import logger from '../utils/logger.js';
import { UNSCOPED, serverScopeWhere } from '../lib/scope.js';
import { log as auditLog } from './auditService.js';
import * as keystoreService from './keystoreService.js';

/** Tag on identities this service created, so it only ever deletes its own. */
export const SUDO_TAG = 'sudo';

export const SAVE_PERMISSIONS = ['servers.manage_credentials', 'keystore.manage'];

function holds(actor, key) {
  const p = actor?.permissions;
  if (!p) return false;
  return p instanceof Set ? p.has(key) : p.includes(key);
}

export function canSaveSudo(actor) {
  return SAVE_PERMISSIONS.every((k) => holds(actor, k));
}

async function loadServer(orgId, serverId, scope) {
  const server = await prisma.server.findFirst({
    where: { id: serverId, orgId, ...serverScopeWhere(scope) },
    select: {
      id: true,
      hostname: true,
      displayName: true,
      sshUser: true,
      sudoCredential: { select: { id: true, name: true, username: true, tags: true, ownerId: true } },
    },
  });
  if (!server) throw new ApiError(404, 'Server not found');
  return server;
}

async function freeName(orgId, base) {
  for (let i = 0; i < 50; i += 1) {
    const name = i === 0 ? base : `${base} (${i + 1})`;
    const taken = await prisma.credential.findFirst({ where: { orgId, ownerId: null, name }, select: { id: true } });
    if (!taken) return name;
  }
  return `${base} (${Date.now().toString(36)})`;
}

/**
 * Save (or replace) the sudo password for a server.
 *
 * @returns {Promise<{ credentialId: string, name: string, created: boolean }>}
 */
export async function saveSudoPassword(orgId, serverId, { password }, actor, { scope = UNSCOPED, source = 'manual' } = {}) {
  if (!canSaveSudo(actor)) {
    throw new ApiError(403, 'Saving a sudo password needs "Bind stored identities to servers" and "Manage Keystore"', {
      code: 'PERMISSION_DENIED',
      details: { missing: SAVE_PERMISSIONS.filter((k) => !holds(actor, k)) },
    });
  }
  if (typeof password !== 'string' || password.length === 0) throw new ApiError(400, 'password is required');
  if (password.length > 1024) throw new ApiError(400, 'password is too long');

  const server = await loadServer(orgId, serverId, scope);
  const label = server.displayName || server.hostname;
  const existing = server.sudoCredential;

  // Replace in place when the bound identity is one this feature created for
  // this user name. Anything else — an identity someone bound by hand, or a
  // different user — is left alone and a fresh one is created beside it.
  if (existing && !existing.ownerId && existing.tags?.includes(SUDO_TAG) && existing.username === server.sshUser) {
    await keystoreService.updateCredential(orgId, existing.id, { password }, actor.userId);
    await auditLog({
      orgId,
      actorId: actor.userId,
      action: 'server.sudo_password.update',
      resourceType: 'Server',
      resourceId: server.id,
      metadata: { credentialId: existing.id, sshUser: server.sshUser, source },
    });
    return { credentialId: existing.id, name: existing.name, created: false };
  }

  const name = await freeName(orgId, `sudo — ${label}`);
  const { credential } = await keystoreService.createCredential(
    orgId,
    {
      name,
      description: `sudo password for ${server.sshUser} on ${label}. Saved from the installer so reinstalls over a certificate do not ask again.`,
      username: server.sshUser,
      authType: 'password',
      password,
      tags: [SUDO_TAG],
    },
    actor.userId
  );
  await prisma.server.update({ where: { id: server.id }, data: { sudoCredentialId: credential.id } });
  await auditLog({
    orgId,
    actorId: actor.userId,
    action: 'server.sudo_password.save',
    resourceType: 'Server',
    resourceId: server.id,
    metadata: { credentialId: credential.id, sshUser: server.sshUser, source },
  });
  return { credentialId: credential.id, name: credential.name, created: true };
}

/**
 * Unbind the saved sudo password. The identity itself is deleted only when
 * this feature created it and nothing else still uses it.
 */
export async function forgetSudoPassword(orgId, serverId, actor, { scope = UNSCOPED } = {}) {
  if (!canSaveSudo(actor)) {
    throw new ApiError(403, 'Removing a saved sudo password needs "Bind stored identities to servers" and "Manage Keystore"', {
      code: 'PERMISSION_DENIED',
      details: { missing: SAVE_PERMISSIONS.filter((k) => !holds(actor, k)) },
    });
  }
  const server = await loadServer(orgId, serverId, scope);
  const cred = server.sudoCredential;
  if (!cred) return { removed: false, deletedIdentity: false };

  await prisma.server.update({ where: { id: server.id }, data: { sudoCredentialId: null } });

  let deletedIdentity = false;
  if (!cred.ownerId && cred.tags?.includes(SUDO_TAG)) {
    const [asSudo, asLogin] = await Promise.all([
      prisma.server.count({ where: { orgId, sudoCredentialId: cred.id } }),
      prisma.server.count({ where: { orgId, credentialId: cred.id } }),
    ]);
    if (asSudo === 0 && asLogin === 0) {
      try {
        await keystoreService.deleteCredential(orgId, cred.id, {}, actor.userId);
        deletedIdentity = true;
      } catch (err) {
        // Still unbound, which is what was asked. The identity stays in the
        // Keystore for someone to clean up by hand.
        logger.warn('serverSudoService: could not delete the sudo identity', { credentialId: cred.id, error: err.message });
      }
    }
  }

  await auditLog({
    orgId,
    actorId: actor.userId,
    action: 'server.sudo_password.forget',
    resourceType: 'Server',
    resourceId: server.id,
    metadata: { credentialId: cred.id, deletedIdentity },
  });
  return { removed: true, deletedIdentity };
}

/**
 * The saved sudo password to use for an install as `principal`, if any.
 *
 * Never throws for "you can't use it" — an install that could have run
 * without the saved password must not fail because of it. The reason comes
 * back as `note` for the install log instead.
 *
 * @returns {Promise<{ password?: string, name?: string, note?: string }>}
 */
export async function resolveSavedSudo(orgId, actor, sudoCredentialId, principal) {
  if (!sudoCredentialId) return {};
  try {
    const { credential, auth } = await keystoreService.resolveCredentialForActor(orgId, actor, sudoCredentialId);
    if (credential.ownerId) return { note: 'The saved sudo password is a personal vault item and cannot be used for a server' };
    if (principal && credential.username && credential.username !== principal) {
      return {
        note: `The saved sudo password is for "${credential.username}", but this install connects as "${principal}" — not used`,
      };
    }
    if (!auth.password) return { note: `The saved sudo identity "${credential.name}" has no password — not used` };
    return { password: auth.password, name: credential.name };
  } catch (err) {
    if (err?.statusCode === 403) return { note: 'A sudo password is saved for this host, but your role cannot use stored identities' };
    if (err?.statusCode === 404) return { note: 'The saved sudo password no longer exists in the Keystore' };
    throw err;
  }
}

export default { saveSudoPassword, forgetSudoPassword, resolveSavedSudo, canSaveSudo, SUDO_TAG };
