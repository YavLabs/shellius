import { AlertTriangle, ShieldCheck, Trash2 } from 'lucide-react';
import Modal from '@/components/shared/Modal';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import SeverityBadge from '@/components/posture/SeverityBadge';
import { DetailRow, DetailSection } from '@/components/posture/DetailRow';
import { serviceLabel } from '@/lib/postureLabels';

/**
 * ListenerDetailModal — the row-click view for one listening socket.
 *
 * The table trims owner names, container ids and paths to fit; this shows
 * them in full, and explains what the reachability verdict actually means,
 * which is the part people most often get wrong (a LOOPBACK row is safe, an
 * INTERNET row on a firewalled host may still be safe, and a Docker publish
 * is reachable whatever the firewall says).
 *
 * Same layout as the Finding modal and the Session details modal: one
 * column of DetailRows under short headings, actions in the footer slot.
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
    blurb:
      'Bound to 127.0.0.1, so only processes on this host can reach it. This is the safe end state for an internal service.',
  },
  FIREWALLED: {
    tone: 'success',
    label: 'Firewalled',
    blurb:
      'Bound wide, but a host firewall rule denies the port. Reachable only if that rule is removed or the firewall is turned off.',
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

function ListenerDetailModal({
  open,
  listener,
  findings = [],
  canExpect = false,
  onClose,
  onOpenFinding,
  onMarkExpected,
  onRemoveExpected,
}) {
  if (!listener) return null;

  // What posture actually concluded about this socket. The listener row is
  // only an observation; the findings are the verdict, and the one people
  // need here most (DOCKER_FIREWALL_BYPASS) is not derivable from the row.
  const related = findings.filter(
    (f) => f.port === listener.port && (!f.proto || f.proto === listener.proto)
  );
  const bypassed = related.some((f) => f.code === 'DOCKER_FIREWALL_BYPASS');

  // A row can also be an expected-port declaration with nothing behind it.
  // Showing a reachability verdict for a socket that does not exist would be
  // inventing an answer.
  const notListening = listener.listening === false;
  const reach = REACHABILITY[listener.reachability] || REACHABILITY.UNKNOWN;
  const { text: service, inferred } = serviceLabel(listener);
  const kind = OWNER_KIND[listener.ownerKind] || listener.ownerKind || null;

  const expected = listener.expected || null;

  const footer = (
    <div className="flex flex-wrap items-center justify-end gap-2" data-sheet-footer>
      <Button variant="outline" onClick={onClose}>
        Close
      </Button>
      {canExpect && expected && onRemoveExpected && (
        <Button variant="outline" onClick={() => onRemoveExpected(expected.id)}>
          <Trash2 className="mr-2 h-4 w-4" /> Stop expecting
        </Button>
      )}
      {canExpect && !expected && onMarkExpected && listener.listening !== false && (
        <Button variant="outline" onClick={() => onMarkExpected(listener)}>
          <ShieldCheck className="mr-2 h-4 w-4" /> Mark expected
        </Button>
      )}
    </div>
  );

  return (
    <Modal open={open} onClose={onClose} title={notListening ? 'Expected port' : 'Listener'} size="lg" footer={footer}>
      <div className="space-y-5">
        <header className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-base font-semibold text-foreground">
              {String(listener.proto || '').toUpperCase()}/{listener.port}
            </span>
            {notListening ? (
              <Badge tone="warning">Not listening</Badge>
            ) : (
              <Badge tone={reach.tone}>{reach.label}</Badge>
            )}
          </div>
          <p className="text-sm leading-relaxed text-muted-foreground">
            {notListening
              ? 'Nothing is serving this port in the most recent snapshot. It is listed because it is marked expected on this host — a declaration that outlived its service will silently cover whatever binds this port next.'
              : reach.blurb}
          </p>
        </header>

        {bypassed && (
          <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2.5">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
            <p className="text-xs leading-relaxed text-amber-800 dark:text-amber-200">
              A firewall rule covers this port, but Docker published it with a DNAT rule in{' '}
              <code className="font-mono">nat/PREROUTING</code>, which traverses{' '}
              <code className="font-mono">FORWARD</code> — not the{' '}
              <code className="font-mono">INPUT</code> chain where ufw and firewalld put host rules.
              The port is reachable regardless of what that rule says.
            </p>
          </div>
        )}

        <DetailSection title="Socket">
          <DetailRow label="Protocol" value={String(listener.proto || '').toUpperCase()} />
          <DetailRow label="Port" value={listener.port} mono />
          <DetailRow label="Bind address" value={listener.bind} mono />
          <DetailRow label="Container port" value={listener.containerPort} mono />
          <DetailRow
            label="Service"
            value={inferred ? <span className="text-muted-foreground">{service}</span> : service}
          />
        </DetailSection>

        {!notListening && (
        <DetailSection title="What owns it">
          <DetailRow
            label="Kind"
            value={kind || <span className="text-muted-foreground">Unattributed</span>}
          />
          <DetailRow label="Name" value={listener.ownerName} mono />
          <DetailRow label="Reference" value={listener.ownerRef} mono />
          <DetailRow label="Unix user" value={listener.ownerUser} mono />
          <DetailRow label="PID" value={listener.pid} mono />
        </DetailSection>
        )}

        {expected && (
          <DetailSection title="Expected on this server">
            <DetailRow label="Reason" value={expected.note} />
            <DetailRow label="Declared by" value={expected.createdBy?.name || 'Unknown'} />
            <DetailRow
              label="Applies to"
              value={expected.proto === 'any' ? 'Both protocols' : expected.proto.toUpperCase()}
            />
            <p className="pt-2 text-xs leading-relaxed text-muted-foreground">
              This port is not reported as exposed on this host. Removing the declaration does not
              reopen the finding immediately — it returns on the next snapshot if the port is still
              listening, which is the only evidence that justifies reopening it.
            </p>
          </DetailSection>
        )}

        {(listener.sourcePath || listener.ownerDetail) && (
          <DetailSection title="Where it is defined">
            <DetailRow label="Source" value={listener.sourcePath} mono />
            <DetailRow label="Detail" value={listener.ownerDetail} mono />
            <p className="pt-2 text-xs leading-relaxed text-muted-foreground">
              This is the file or unit that starts the service — the place to change the bind
              address if this port should not be reachable.
            </p>
          </DetailSection>
        )}

        {related.length > 0 && (
          <DetailSection title={`Findings on this port (${related.length})`}>
            <ul className="divide-y divide-border">
              {related.map((f) => (
                <li key={f.id}>
                  <button
                    type="button"
                    onClick={() => onOpenFinding?.(f)}
                    disabled={!onOpenFinding}
                    className="grid w-full grid-cols-3 gap-3 py-2.5 text-left enabled:hover:bg-accent/40 disabled:cursor-default"
                  >
                    <span className="col-span-1">
                      <SeverityBadge severity={f.severity} />
                    </span>
                    <span className="col-span-2 text-sm text-foreground">{f.message}</span>
                  </button>
                </li>
              ))}
            </ul>
          </DetailSection>
        )}
      </div>
    </Modal>
  );
}

export default ListenerDetailModal;
