/**
 * Shared wording for posture rows — used by the listeners table, the listener
 * detail modal and anything else that has to describe a socket. Kept in lib
 * so the table and the modal can never word the same row differently, and so
 * neither has to import the other.
 */

/**
 * What the Service column shows.
 *
 * `service` is only set when the collector recognised an actual protocol
 * (PostgreSQL, MySQL/MariaDB, HTTP...). Saying "Unknown" for everything else
 * was accurate but useless: the row always knows what KIND of thing is
 * listening, so name that instead.
 *
 * The identifier chosen is deliberately the one the Owner column does NOT
 * already show — Owner gives docker/<name> and pm2/<name>, so this gives the
 * container id and the pm2 process index. Where there is no second
 * identifier (systemd), the kind alone is still more useful than "Unknown".
 *
 * Inferred labels render muted so a real protocol match stays visually
 * distinct from "we only know it is a container".
 */
export function serviceLabel(listener) {
  if (listener?.service) return { text: listener.service, inferred: false };

  const ref = listener?.ownerRef || null;
  const name = listener?.ownerName || null;
  const inferred = (text) => ({ text, inferred: true });

  switch (listener?.ownerKind) {
    case 'docker':
    case 'docker-proxy':
      return inferred(
        ref ? `Docker container ${ref}` : name ? `Docker container ${name}` : 'Docker container'
      );
    case 'pm2':
      // pm2 refs arrive as "#0"; fall back to the process name when the
      // index was not captured.
      return inferred(ref ? `PM2 process ${ref}` : name ? `PM2 process ${name}` : 'PM2 process');
    case 'systemd':
      return inferred('systemd unit');
    case 'podman':
      return inferred(ref ? `Podman container ${ref}` : 'Podman container');
    default:
      // No owner attribution at all (the process exited before /proc could be
      // read, spec §7) — the raw process name is the last thing we have.
      return inferred(listener?.process ? `Process ${listener.process}` : 'Unidentified');
  }
}


/**
 * Finding codes that declaring a port expected actually resolves.
 *
 * Mirrors SUPERSEDED_CODES in backend/src/services/postureExpectedPortService.js
 * — the backend is the source of truth; this copy exists so the UI can avoid
 * offering an action that would be a no-op.
 *
 * The exclusions are deliberate, not gaps:
 *   FIREWALL_INACTIVE    host-wide, has no port to declare.
 *   STALE_FIREWALL_RULE  a rule for a port nothing is listening on. Calling
 *                        the port expected does not make the rule less stale.
 *   EXPECTED_PUBLIC      already expected; there is nothing to suppress.
 */
export const EXPECTED_PORT_RESOLVES = ['PORT_EXPOSED', 'SENSITIVE_PORT_EXPOSED', 'DOCKER_FIREWALL_BYPASS'];

/** Would "Mark expected" do anything for this finding? */
export function canMarkExpected(finding) {
  return !!finding?.port && EXPECTED_PORT_RESOLVES.includes(finding.code);
}
