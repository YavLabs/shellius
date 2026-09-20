import { Check, ExternalLink, ShieldCheck, Volume1, VolumeX } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import Modal from '@/components/shared/Modal';
import { Button } from '@/components/ui/button';
import SeverityBadge from '@/components/posture/SeverityBadge';
import FindingStatusBadge from '@/components/posture/FindingStatusBadge';
import EnvironmentBadge from '@/components/shared/EnvironmentBadge';
import { DetailRow, DetailSection } from '@/components/posture/DetailRow';
import { formatDateTime, relativeTime } from '@/utils/time';
import { canMarkExpected } from '@/lib/postureLabels';

/**
 * FindingDetailModal — the row-click view for an exposure finding.
 *
 * The table can only show the one-line message; everything that makes a
 * finding actionable (how long it has been open, what to actually do about
 * it, what the collector observed) lives here. Opened from both the fleet
 * Posture page and the per-server Posture tab, so the two can never explain
 * the same finding differently.
 *
 * Layout follows the Session details modal: a single column of DetailRows
 * under short section headings, values left-aligned, actions in the modal's
 * own footer slot rather than inside the scrolling body.
 */

/**
 * What to do about each finding code.
 *
 * Deliberately in the frontend: this is advice for a human, not data the
 * collector produced, and keeping it out of the stored row means improving
 * the wording never needs a migration or a re-scan.
 */
const REMEDIATION = {
  SENSITIVE_PORT_EXPOSED:
    'A datastore reachable from any address is the finding most likely to end badly. Bind it to 127.0.0.1 and reach it over an SSH tunnel, or restrict the port at the firewall. For a container, publish as "127.0.0.1:<port>:<port>" rather than "<port>:<port>".',
  PORT_EXPOSED:
    'If this is meant to be internal, bind it to 127.0.0.1 behind a reverse proxy. If it is genuinely meant to be public on this host, use "Mark expected" below — that records the reason, resolves this finding and stops it reopening, without silencing the same port on every other server.',
  DOCKER_FIREWALL_BYPASS:
    'Docker publishes this port with a DNAT rule in nat/PREROUTING, which traverses FORWARD — it never reaches the INPUT chain where ufw and firewalld put host rules. The port is reachable no matter what those rules say. Bind the publish to 127.0.0.1, or use a Docker-aware integration (ufw-docker, or firewalld’s docker zone).',
  FIREWALL_INACTIVE:
    'Check the existing rules before enabling it: on a host whose services all bind wildcard, a default-deny firewall will cut off anything the rules do not explicitly allow — including your own SSH session.',
  FIREWALL_STATE_UNKNOWN:
    'IPv4 and IPv6 policy disagree for this port, so reporting the IPv4 answer alone would be a guess. Check the rules for both address families on the host.',
  STALE_FIREWALL_RULE:
    'A firewall rule allows a port nothing is listening on. Harmless today, but it will silently expose whatever binds that port next. Remove the rule if the service is gone for good.',
  STOPPED_SERVICE_PORT_OPEN:
    'This is not an abandoned rule — the service that serves this port is installed and stopped, and starting it re-opens the port with the firewall already allowing it. Decide which you meant: if the service is retired, remove it and the rule together; if it is meant to run, start it and re-check where it binds.',
  EXPECTED_PUBLIC:
    'This port is expected to be public and is recorded so the inventory is complete, not because anything is wrong.',
};

/** `detail` is a free-form JSON blob; render its keys as ordinary rows. */
const DETAIL_LABELS = {
  bind: 'Bind',
  matchedBy: 'Matched by',
  from: 'Rule source',
  firewallEngine: 'Firewall',
  serviceKind: 'Runtime',
  serviceName: 'Service',
  serviceState: 'State',
  serviceStatus: 'Reported status',
  exitCode: 'Exit code',
};

function FindingDetailModal({
  open,
  finding,
  onClose,
  canMute = false,
  onAcknowledge,
  onMute,
  onUnmute,
  busy = false,
  // Declaring a port expected is per server, so only the server tab offers it
  // — from the fleet page the finding's server is not the page's subject.
  canExpect = false,
  onMarkExpected,
  // The server tab already IS the server, so it hides this jump.
  showServerLink = true,
}) {
  const navigate = useNavigate();
  if (!finding) return null;

  const advice = REMEDIATION[finding.code];
  const where = [finding.proto, finding.port].filter(Boolean).join('/');
  const server = finding.server;

  const go = (path) => {
    onClose?.();
    navigate(path);
  };

  const footer = (
    <div className="flex flex-wrap items-center justify-end gap-2" data-sheet-footer>
      <Button variant="outline" onClick={onClose}>
        Close
      </Button>
      {canMute && finding.status === 'muted' && onUnmute && (
        <Button variant="outline" disabled={busy} onClick={() => onUnmute(finding)}>
          <Volume1 className="mr-2 h-4 w-4" /> Unmute
        </Button>
      )}
      {/* Offered only when it would actually do something. A firewall
          finding has no port, and an already-expected one has nothing left
          to suppress — showing the button there is a promise the action
          cannot keep. */}
      {canExpect && onMarkExpected && canMarkExpected(finding) && !finding.resolvedAt && (
        <Button variant="outline" disabled={busy} onClick={() => onMarkExpected(finding)}>
          <ShieldCheck className="mr-2 h-4 w-4" /> Mark expected
        </Button>
      )}
      {canMute && finding.status === 'open' && onMute && (
        <Button variant="outline" disabled={busy} onClick={() => onMute(finding)}>
          <VolumeX className="mr-2 h-4 w-4" /> Mute…
        </Button>
      )}
      {canMute && finding.status === 'open' && !finding.acknowledgedAt && onAcknowledge && (
        <Button disabled={busy} onClick={() => onAcknowledge(finding)}>
          <Check className="mr-2 h-4 w-4" /> Acknowledge
        </Button>
      )}
    </div>
  );

  return (
    <Modal open={open} onClose={onClose} title="Finding" size="lg" footer={footer}>
      <div className="space-y-5">
        <header className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <SeverityBadge severity={finding.severity} />
            <FindingStatusBadge status={finding.status} />
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
              {finding.code}
            </code>
          </div>
          <p className="text-sm leading-relaxed text-foreground">{finding.message}</p>
          {advice && (
            <p className="border-l-2 border-border pl-3 text-xs leading-relaxed text-muted-foreground">
              {advice}
            </p>
          )}
        </header>

        {canExpect && finding.port && !canMarkExpected(finding) && !finding.resolvedAt && (
          <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            Marking a port expected does not apply here: this finding is about
            {finding.code === 'STALE_FIREWALL_RULE'
              ? ' a firewall rule for a port nothing is listening on, which stays stale either way.'
              : ' a port that is already treated as expected.'}
          </p>
        )}

        <DetailSection title="What is listening">
          <DetailRow label="Port" value={where || null} mono />
          <DetailRow
            label="Service"
            value={finding.service || <span className="text-muted-foreground">Not identified</span>}
          />
          <DetailRow
            label="Owner"
            value={finding.ownerLabel || <span className="text-muted-foreground">Unattributed</span>}
            mono={!!finding.ownerLabel}
          />
          {Object.entries(finding.detail || {}).map(([k, v]) => (
            <DetailRow key={k} label={DETAIL_LABELS[k] || k} value={String(v)} mono />
          ))}
        </DetailSection>

        <DetailSection title="History">
          <DetailRow
            label="First seen"
            value={
              <span title={formatDateTime(finding.firstSeenAt)}>
                {relativeTime(finding.firstSeenAt)}
                <span className="ml-2 text-muted-foreground">{formatDateTime(finding.firstSeenAt)}</span>
              </span>
            }
          />
          <DetailRow
            label="Last seen"
            value={
              <span title={formatDateTime(finding.lastSeenAt)}>
                {relativeTime(finding.lastSeenAt)}
                <span className="ml-2 text-muted-foreground">{formatDateTime(finding.lastSeenAt)}</span>
              </span>
            }
          />
          <DetailRow
            label="Acknowledged"
            value={finding.acknowledgedAt ? formatDateTime(finding.acknowledgedAt) : null}
          />
          <DetailRow label="Muted until" value={finding.mutedUntil ? formatDateTime(finding.mutedUntil) : null} />
          <DetailRow label="Mute reason" value={finding.mutedReason} />
          <DetailRow
            label="Resolved"
            value={
              finding.resolvedAt ? (
                formatDateTime(finding.resolvedAt)
              ) : (
                <span className="text-muted-foreground">Still present in the most recent snapshot</span>
              )
            }
          />
        </DetailSection>

        {server && (
          <DetailSection title="Where">
            <DetailRow
              label="Server"
              value={
                showServerLink ? (
                  <button
                    type="button"
                    onClick={() => go(`/servers/${server.id}?tab=findings`)}
                    className="inline-flex items-center gap-1 text-primary hover:underline"
                  >
                    {server.displayName || server.hostname}
                    <ExternalLink className="h-3 w-3" />
                  </button>
                ) : (
                  server.displayName || server.hostname
                )
              }
            />
            <DetailRow
              label="Environment"
              value={server.environment ? <EnvironmentBadge environment={server.environment} /> : null}
            />
            <DetailRow label="Customer" value={server.customer?.name} />
          </DetailSection>
        )}
      </div>
    </Modal>
  );
}

export default FindingDetailModal;
