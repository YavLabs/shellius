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
 * Human labels for a finding's `code` — the Finding-type filter's options are
 * built from whatever codes the fleet actually has (getSummary's `codes`
 * facet), so a code Shellius has never produced yet still renders as itself
 * rather than disappearing from the list.
 */
const CODE_LABELS = {
  DOCKER_FIREWALL_BYPASS: 'Docker bypasses the host firewall',
  SENSITIVE_PORT_EXPOSED: 'Sensitive port exposed',
  PORT_EXPOSED: 'Port exposed',
  FIREWALL_INACTIVE: 'Firewall inactive',
  STALE_FIREWALL_RULE: 'Stale firewall rule',
  EXPECTED_PUBLIC: 'Marked as expected',
};

export function codeLabel(code) {
  return CODE_LABELS[code] || code;
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

/**
 * Which section of the findings inbox a finding belongs to.
 *
 * The inbox is four sections, not four tabs, and they have to PARTITION —
 * a finding counted in two places makes every total wrong. Precedence:
 *
 *   muted        a live mute wins outright; it is deliberately out of sight.
 *   expected     a port someone declared public on purpose. It is inventory,
 *                not a problem, so it never sits in the open queue even
 *                after someone acknowledges it.
 *   acknowledged seen, accepted, not yet fixed.
 *   open         everything left — the only section that is actually a queue.
 *
 * Mirrors the counts in postureQueryService.getSummary; the backend is the
 * source of truth for the numbers, this is the source of truth for which
 * rows land where.
 */
export const FINDING_SECTIONS = ['open', 'expected', 'acknowledged', 'muted', 'resolved'];

export function findingSection(finding) {
  if (!finding) return 'open';
  if (finding.status === 'resolved') return 'resolved';
  if (finding.status === 'muted') return 'muted';
  if (finding.code === 'EXPECTED_PUBLIC') return 'expected';
  if (finding.status === 'acknowledged' || finding.acknowledgedAt) return 'acknowledged';
  return 'open';
}

/** Group a list of findings into the sections above, in order. */
export function partitionFindings(findings = []) {
  const out = { open: [], expected: [], acknowledged: [], muted: [], resolved: [] };
  for (const f of findings) out[findingSection(f)].push(f);
  return out;
}
