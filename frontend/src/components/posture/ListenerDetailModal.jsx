import { AlertTriangle } from 'lucide-react';
import Modal from '@/components/shared/Modal';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { serviceLabel } from '@/lib/postureLabels';
import SeverityBadge from '@/components/posture/SeverityBadge';

/**
 * ListenerDetailModal — the row-click view for one listening socket.
 *
 * The table trims owner names, container ids and paths to fit; this shows
 * them in full, and explains what the reachability verdict actually means,
 * which is the part people most often get wrong (a "LOOPBACK" row is safe,
 * an "INTERNET" row on a host with a firewall may still be safe, and a
 * Docker publish is reachable whatever the firewall says).
 */

const REACHABILITY = {
  INTERNET: {
    tone: 'danger',
    label: 'Internet',
    blurb:
      'Bound to a wildcard or public address and not blocked by a host firewall rule Shellius can see. Treat it as reachable from anywhere the host is.',
  },
  LAN: {
    tone: 'warning',
    label: 'LAN',
    blurb: 'Bound to a private address, so it is reachable from the local network but not directly from the internet.',
  },
  LOOPBACK: {
    tone: 'success',
    label: 'Loopback',
    blurb: 'Bound to 127.0.0.1, so only processes on this host can reach it. This is the safe end state for an internal service.',
  },
  FIREWALLED: {
    tone: 'success',
    label: 'Firewalled',
    blurb: 'Bound wide, but a host firewall rule denies the port. Reachable only if that rule is removed or the firewall is turned off.',
  },
  UNKNOWN: {
    tone: 'neutral',
    label: 'Unknown',
    blurb:
      'Shellius could not reach a firm verdict — usually an unrecognised firewall engine, or IPv4 and IPv6 policy that disagree. Check the host directly rather than assuming either answer.',
  },
};

const OWNER_KIND = {
  docker: 'Docker container',
  'docker-proxy': 'Docker container',
  podman: 'Podman container',
  pm2: 'pm2 process',
  systemd: 'systemd unit',
};

function Row({ label, children, mono }) {
  if (children === null || children === undefined || children === '') return null;
  return (
    <div className="flex items-start justify-between gap-4 py-1.5">
      <span className="shrink-0 text-xs text-muted-foreground">{label}</span>
      <span className={`min-w-0 break-all text-right text-sm text-foreground ${mono ? 'font-mono text-xs' : ''}`}>
        {children}
      </span>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div className="rounded-lg border border-border bg-muted/20 p-3">
      <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">{title}</p>
      {children}
    </div>
  );
}

function ListenerDetailModal({ open, listener, findings = [], onClose, onOpenFinding }) {
  if (!listener) return null;

  // What posture actually concluded about this socket. The listener row is
  // only an observation; the findings are the verdict, and the one people
  // need here most (DOCKER_FIREWALL_BYPASS) is not derivable from the row.
  const related = findings.filter(
    (f) => f.port === listener.port && (!f.proto || f.proto === listener.proto)
  );

  const reach = REACHABILITY[listener.reachability] || REACHABILITY.UNKNOWN;
  const { text: service, inferred } = serviceLabel(listener);
  const kind = OWNER_KIND[listener.ownerKind] || listener.ownerKind || null;

  return (
    <Modal open={open} onClose={onClose} title="Listener" size="lg">
      <div className="space-y-4 p-5 max-md:p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-base font-semibold text-foreground">
            {String(listener.proto || '').toUpperCase()}/{listener.port}
          </span>
          <Badge tone={reach.tone}>{reach.label}</Badge>
        </div>

        <p className="text-xs leading-relaxed text-muted-foreground">{reach.blurb}</p>

        {related.some((f) => f.code === 'DOCKER_FIREWALL_BYPASS') && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2.5">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
            <p className="text-xs leading-relaxed text-amber-800 dark:text-amber-200">
              A firewall rule covers this port, but Docker published it with a DNAT rule in
              <code className="mx-1 font-mono">nat/PREROUTING</code>, which traverses
              <code className="mx-1 font-mono">FORWARD</code> — not the
              <code className="mx-1 font-mono">INPUT</code> chain where ufw and firewalld put host
              rules. The port is reachable regardless of what that rule says.
            </p>
          </div>
        )}

        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Section title="Socket">
            <Row label="Protocol">{String(listener.proto || '').toUpperCase()}</Row>
            <Row label="Port" mono>{listener.port}</Row>
            <Row label="Bind address" mono>{listener.bind}</Row>
            {listener.containerPort ? (
              <Row label="Container port" mono>
                {listener.containerPort}
              </Row>
            ) : null}
            <Row label="Service">
              {inferred ? <span className="text-muted-foreground">{service}</span> : service}
            </Row>
          </Section>

          <Section title="What owns it">
            <Row label="Kind">{kind || <span className="text-muted-foreground">Unattributed</span>}</Row>
            <Row label="Name">{listener.ownerName}</Row>
            <Row label="Reference" mono>{listener.ownerRef}</Row>
            <Row label="Unix user" mono>{listener.ownerUser}</Row>
            <Row label="PID" mono>{listener.pid}</Row>
          </Section>
        </div>

        {(listener.sourcePath || listener.ownerDetail) && (
          <Section title="Where it is defined">
            <Row label="Source" mono>{listener.sourcePath}</Row>
            <Row label="Detail" mono>{listener.ownerDetail}</Row>
            <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
              This is the file or unit that starts the service — the place to change the bind
              address if this port should not be reachable.
            </p>
          </Section>
        )}
        {related.length > 0 && (
          <Section title={`Findings on this port (${related.length})`}>
            <ul className="space-y-1">
              {related.map((f) => (
                <li key={f.id}>
                  <button
                    type="button"
                    onClick={() => onOpenFinding?.(f)}
                    disabled={!onOpenFinding}
                    className="flex w-full items-start gap-2 rounded-md px-1 py-1 text-left enabled:hover:bg-accent/50 disabled:cursor-default"
                  >
                    <SeverityBadge severity={f.severity} />
                    <span className="min-w-0 flex-1 text-xs text-foreground">{f.message}</span>
                  </button>
                </li>
              ))}
            </ul>
          </Section>
        )}
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-4 max-md:px-4">
        <Button variant="outline" onClick={onClose}>
          Close
        </Button>
      </div>
    </Modal>
  );
}

export default ListenerDetailModal;
