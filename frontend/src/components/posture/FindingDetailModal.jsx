import { Check, ExternalLink, ShieldCheck, Volume1, VolumeX } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import Modal from '@/components/shared/Modal';
import { Button } from '@/components/ui/button';
import SeverityBadge from '@/components/posture/SeverityBadge';
import FindingStatusBadge from '@/components/posture/FindingStatusBadge';
import EnvironmentBadge from '@/components/shared/EnvironmentBadge';
import { formatDateTime, relativeTime } from '@/utils/time';

/**
 * FindingDetailModal — the row-click view for an exposure finding.
 *
 * The table can only show the one-line message; everything that makes a
 * finding actionable (how long it has been open, what to actually do about
 * it, what the collector observed) lives here. Opened from both the fleet
 * Posture page and the per-server Posture tab, so the two can never explain
 * the same finding differently.
 */

/**
 * What to do about each finding code.
 *
 * Deliberately in the frontend: this is advice for a human, not data the
 * collector produced, and keeping it out of the stored row means improving
 * the wording never needs a migration or a re-scan.
 */
const REMEDIATION = {
  SENSITIVE_PORT_EXPOSED: {
    title: 'Close this off first',
    body: 'A datastore reachable from any address is the finding most likely to end badly. Bind it to 127.0.0.1 and reach it over an SSH tunnel, or restrict the port at the firewall. For a container, publish as "127.0.0.1:<port>:<port>" rather than "<port>:<port>".',
  },
  PORT_EXPOSED: {
    title: 'Confirm this is intended',
    body: 'Reachable from any source address and not a service normally exposed to the internet. If it is meant to be internal, bind it to 127.0.0.1 behind a reverse proxy. If it is genuinely meant to be public, add it to the expected-public list in Administration → Posture so it stops being reported.',
  },
  DOCKER_FIREWALL_BYPASS: {
    title: 'The firewall rule you think covers this does not',
    body: 'Docker publishes this port with a DNAT rule in nat/PREROUTING, which traverses FORWARD — it never reaches the INPUT chain where ufw and firewalld put host rules. The port is reachable no matter what those rules say. Bind the publish to 127.0.0.1, or use a Docker-aware integration (ufw-docker, or firewalld’s docker zone).',
  },
  FIREWALL_INACTIVE: {
    title: 'Turn it on — but read the rules first',
    body: 'The firewall is installed and holding rules that are not being enforced, so every listener on this host is currently reachable. Check the existing rules before enabling it: on a host whose services all bind wildcard, enabling a default-deny firewall will cut off anything the rules do not explicitly allow, including your own SSH session.',
  },
  FIREWALL_STATE_UNKNOWN: {
    title: 'Shellius cannot answer for this port',
    body: 'The firewall reported IPv4 and IPv6 policy that disagree for this port, so reporting the IPv4 answer alone would be a guess. Check the rules for both address families directly on the host.',
  },
  STALE_FIREWALL_RULE: {
    title: 'Housekeeping, not a risk',
    body: 'A firewall rule allows a port that nothing is listening on. Harmless today, but it will silently expose whatever binds that port next. Remove the rule if the service is gone for good.',
  },
  EXPECTED_PUBLIC: {
    title: 'No action needed',
    body: 'This port is expected to be public and is recorded here so the inventory is complete, not because anything is wrong.',
  },
};

function Row({ label, children }) {
  if (children === null || children === undefined || children === '') return null;
  return (
    <div className="flex items-start justify-between gap-4 py-1.5">
      <span className="shrink-0 text-xs text-muted-foreground">{label}</span>
      <span className="min-w-0 text-right text-sm text-foreground">{children}</span>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div className="rounded-lg border border-border bg-muted/20 p-3">
      <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
        {title}
      </p>
      {children}
    </div>
  );
}

function FindingDetailModal({
  open,
  finding,
  onClose,
  canMute = false,
  onAcknowledge,
  onMute,
  onUnmute,
  busy = false,
  // The server tab already IS the server, so it hides this jump.
  showServerLink = true,
}) {
  const navigate = useNavigate();
  if (!finding) return null;

  const advice = REMEDIATION[finding.code];
  const where = [finding.proto, finding.port].filter(Boolean).join('/');
  const server = finding.server;
  const detailEntries = Object.entries(finding.detail || {});

  const go = (path) => {
    onClose?.();
    navigate(path);
  };

  return (
    <Modal open={open} onClose={onClose} title="Finding" size="lg">
      <div className="space-y-4 p-5 max-md:p-4">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <SeverityBadge severity={finding.severity} />
            <FindingStatusBadge finding={finding} />
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
              {finding.code}
            </code>
          </div>
          <p className="text-sm text-foreground">{finding.message}</p>
        </div>

        {advice && (
          <div className="rounded-lg border border-border bg-muted/30 p-3">
            <p className="flex items-center gap-1.5 text-sm font-medium text-foreground">
              <ShieldCheck className="h-4 w-4 shrink-0 text-muted-foreground" />
              {advice.title}
            </p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{advice.body}</p>
          </div>
        )}

        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Section title="What is listening">
            <Row label="Port">{where ? <span className="font-mono">{where}</span> : '—'}</Row>
            <Row label="Service">{finding.service || <span className="text-muted-foreground">Not identified</span>}</Row>
            <Row label="Owner">
              {finding.ownerLabel ? (
                <span className="font-mono text-xs">{finding.ownerLabel}</span>
              ) : (
                <span className="text-muted-foreground">Unattributed</span>
              )}
            </Row>
            {detailEntries.map(([k, v]) => (
              <Row key={k} label={k.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase())}>
                <span className="font-mono text-xs">{String(v)}</span>
              </Row>
            ))}
          </Section>

          <Section title="History">
            <Row label="First seen">
              <span title={formatDateTime(finding.firstSeenAt)}>{relativeTime(finding.firstSeenAt)}</span>
            </Row>
            <Row label="Last seen">
              <span title={formatDateTime(finding.lastSeenAt)}>{relativeTime(finding.lastSeenAt)}</span>
            </Row>
            {finding.acknowledgedAt && (
              <Row label="Acknowledged">
                <span title={formatDateTime(finding.acknowledgedAt)}>{relativeTime(finding.acknowledgedAt)}</span>
              </Row>
            )}
            {finding.mutedUntil && (
              <Row label="Muted until">{formatDateTime(finding.mutedUntil)}</Row>
            )}
            {finding.mutedReason && <Row label="Mute reason">{finding.mutedReason}</Row>}
            {finding.resolvedAt && (
              <Row label="Resolved">
                <span title={formatDateTime(finding.resolvedAt)}>{relativeTime(finding.resolvedAt)}</span>
              </Row>
            )}
            {!finding.resolvedAt && (
              <p className="mt-1 text-[11px] text-muted-foreground">
                Still present in the most recent snapshot.
              </p>
            )}
          </Section>
        </div>

        {server && (
          <Section title="Where">
            <Row label="Server">
              {showServerLink ? (
                <button
                  type="button"
                  onClick={() => go(`/servers/${server.id}?tab=posture`)}
                  className="inline-flex items-center gap-1 text-primary hover:underline"
                >
                  {server.displayName || server.hostname}
                  <ExternalLink className="h-3 w-3" />
                </button>
              ) : (
                server.displayName || server.hostname
              )}
            </Row>
            <Row label="Environment">
              {server.environment ? <EnvironmentBadge environment={server.environment} /> : null}
            </Row>
            <Row label="Customer">{server.customer?.name}</Row>
          </Section>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border px-5 py-4 max-md:px-4">
        <Button variant="outline" onClick={onClose}>
          Close
        </Button>
        {canMute && finding.status === 'open' && !finding.acknowledgedAt && onAcknowledge && (
          <Button variant="outline" disabled={busy} onClick={() => onAcknowledge(finding)}>
            <Check className="mr-2 h-4 w-4" /> Acknowledge
          </Button>
        )}
        {canMute && finding.status === 'open' && onMute && (
          <Button variant="outline" disabled={busy} onClick={() => onMute(finding)}>
            <VolumeX className="mr-2 h-4 w-4" /> Mute…
          </Button>
        )}
        {canMute && finding.status === 'muted' && onUnmute && (
          <Button variant="outline" disabled={busy} onClick={() => onUnmute(finding)}>
            <Volume1 className="mr-2 h-4 w-4" /> Unmute
          </Button>
        )}
      </div>
    </Modal>
  );
}

export default FindingDetailModal;
