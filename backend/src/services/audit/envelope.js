/**
 * envelope.js — the shape an audit entry takes when it leaves Shellius.
 *
 * One versioned record used by every sink, by the archive and by the manual
 * JSON export, so what a SIEM receives, what sits in an archive object and
 * what someone downloads from the UI all describe an event the same way.
 * `v` is there so a later change can be recognised rather than guessed at.
 *
 * Metadata has already been scrubbed by redactValue on the way in
 * (auditService.log), but it is scrubbed again here: rows written before a
 * given redaction rule existed would otherwise be shipped in the clear the
 * first time an org turns a sink on.
 */

import { redactValue } from '../../utils/logger.js';

export const ENVELOPE_VERSION = 1;

/**
 * Rough severity, derived from the action rather than stored, so existing
 * rows get one too. Syslog needs a number; a SIEM wants something to alert
 * on without knowing every action name.
 */
// `revoke` rather than `revoked`, so it matches both the action name
// (api_token.revoke) and the past tense (user.sessions.revoked).
const WARNING = /(fail|denied|revoke|locked|disabled|reuse|blocked|aborted|break_glass|prod_bypass)/;
const NOTICE = /(create|update|delete|rotate|approve|deny|suspend|deprovision|activate|deactivate)/;

export function severityFor(action) {
  const a = String(action || '');
  if (WARNING.test(a)) return 'warning';
  if (NOTICE.test(a)) return 'notice';
  return 'info';
}

/** RFC 5424 severity numbers, for the syslog sink. */
export const SYSLOG_SEVERITY = { warning: 4, notice: 5, info: 6, debug: 7 };

/**
 * @param {object} row  an AuditLog row
 * @param {object} [ctx]
 * @param {object} [ctx.actor]          `{ id, name, email, kind }` when resolved
 * @param {string} [ctx.resourceLabel]  human name of the resource, when known
 */
export function toEnvelope(row, { actor = null, resourceLabel = null } = {}) {
  const action = row.action;
  return {
    v: ENVELOPE_VERSION,
    id: row.id,
    orgId: row.orgId,
    occurredAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
    action,
    // The part before the first dot: auth, user, server, api_token…
    category: String(action || '').split('.')[0] || 'unknown',
    severity: severityFor(action),
    resource: {
      type: row.resourceType ?? null,
      id: row.resourceId ?? null,
      label: resourceLabel,
    },
    actor: actor
      ? { id: actor.id, name: actor.name ?? null, email: actor.email ?? null, kind: actor.kind ?? 'human' }
      : row.actorId
        ? { id: row.actorId, name: null, email: null, kind: null }
        : null,
    ipAddress: row.ipAddress ?? null,
    metadata: row.metadata == null ? null : redactValue(row.metadata),
  };
}

export default { ENVELOPE_VERSION, SYSLOG_SEVERITY, severityFor, toEnvelope };
