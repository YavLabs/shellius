/**
 * auditNameSnapshot.js — the name of what a DELETE is about to remove,
 * captured before the handler runs, for the audit row's metadata.
 *
 * Audit search resolves most resource names by looking the id up in the
 * live table (auditService RESOURCE_NAME_SEARCH). A deleted row is gone, so
 * "who deleted the Backup policy?" found nothing: the generic audit()
 * middleware stored only method and path. With the name in metadata,
 * search's `metadata::text ILIKE` branch finds it, and the list can label it.
 *
 * Always org-scoped; Keystore items only from the shared (org) Keystore —
 * a personal item's name is never copied into an org-visible audit row.
 */
import prisma from '../config/db.js';
import logger from './logger.js';

export const NAME_SNAPSHOT = {
  AccessPolicy: { model: 'accessPolicy', select: { name: true }, name: (r) => r.name },
  Group: { model: 'group', select: { name: true }, name: (r) => r.name },
  Role: { model: 'role', select: { name: true }, name: (r) => r.name },
  Customer: { model: 'customer', select: { name: true }, name: (r) => r.name },
  Server: {
    model: 'server',
    select: { hostname: true, displayName: true },
    name: (r) => r.displayName || r.hostname,
    extra: (r) => ({ hostname: r.hostname }),
  },
  Credential: { model: 'credential', scope: { ownerId: null }, select: { name: true }, name: (r) => r.name },
  SshKey: { model: 'sshKey', scope: { ownerId: null }, select: { name: true }, name: (r) => r.name },
  CaKeyPair: { model: 'caKeyPair', select: { name: true }, name: (r) => r.name },
  SsoConfig: { model: 'ssoConfig', select: { name: true }, name: (r) => r.name },
  EmailProvider: { model: 'emailProvider', select: { name: true }, name: (r) => r.name },
  PostureAlertRule: { model: 'postureAlertRule', select: { name: true }, name: (r) => r.name },
};

/**
 * @returns {Promise<object|null>} `{ name, ...extra }` or null (unknown type,
 *   not found, personal item, or the lookup failed — never throws)
 */
export async function snapshotName(orgId, resourceType, id, { db = prisma } = {}) {
  const spec = NAME_SNAPSHOT[resourceType];
  if (!spec || !orgId || !id) return null;
  try {
    const row = await db[spec.model].findFirst({
      // org predicate last so no `scope` entry can override it
      where: { ...(spec.scope ?? {}), id, orgId },
      select: spec.select,
    });
    if (!row) return null;
    const name = spec.name(row);
    return name ? { name, ...(spec.extra ? spec.extra(row) : {}) } : null;
  } catch (err) {
    logger.warn('audit: name snapshot failed', { resourceType, error: err.message });
    return null;
  }
}

export default { NAME_SNAPSHOT, snapshotName };
