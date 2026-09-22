import { Download, Radar, RefreshCw, ShieldCheck } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { relativeTime } from '@/utils/time';

/**
 * The two things Shellius runs on a host — SSH trust (CA + agent) and the
 * posture collector — each as one badge that says whether it works.
 *
 * The verdict comes from the API (`server.sshTrust`, `server.collector`,
 * computed by serverAgentStatus.js), never re-derived here, so every list
 * that shows a host says the same thing about it. Clicking a badge explains
 * the state and, where there is a fix, offers it — so a red badge is never a
 * dead end.
 */

/** What would fix each state, if anything. */
const SSH_FIX = {
  not_installed: { label: 'Bootstrap host', scope: 'full' },
  failed: { label: 'Retry bootstrap', scope: 'full' },
  no_heartbeat: { label: 'Re-run bootstrap', scope: 'full' },
  stale: { label: 'Re-run bootstrap', scope: 'full' },
  legacy_token: { label: 'Re-run bootstrap', scope: 'full' },
  identity_auth: { label: 'Bootstrap for certificate access', scope: 'full' },
};
const COLLECTOR_FIX = {
  not_installed: { label: 'Install collector' },
  degraded: { label: 'Reinstall collector' },
  rejected: { label: 'Update collector' },
  stale: { label: 'Reinstall collector' },
  outdated: { label: 'Update collector' },
};

function StatusBadge({ kind, status, onFix, canFix }) {
  if (!status) return <span className="text-xs text-muted-foreground">—</span>;
  const Icon = kind === 'ssh' ? ShieldCheck : Radar;
  const fix = (kind === 'ssh' ? SSH_FIX : COLLECTOR_FIX)[status.state];
  const title = kind === 'ssh' ? 'SSH trust (CA + agent)' : 'Posture collector';
  const when = kind === 'ssh' ? status.lastSeenAt : status.lastReportAt;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          onClick={(e) => e.stopPropagation()}
          className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={`${title}: ${status.label}. Show details`}
        >
          <Badge tone={status.tone} dot className="cursor-pointer whitespace-nowrap">
            {status.label}
          </Badge>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-3" onClick={(e) => e.stopPropagation()}>
        <p className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
          <Icon className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
          {title}
        </p>
        <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{status.detail}</p>
        <dl className="mt-2 space-y-0.5 text-[11px] text-muted-foreground">
          {when && (
            <div className="flex justify-between gap-2">
              <dt>{kind === 'ssh' ? 'Last heartbeat' : 'Last report'}</dt>
              <dd className="text-foreground">{relativeTime(when)}</dd>
            </div>
          )}
          {kind === 'collector' && status.version && (
            <div className="flex justify-between gap-2">
              <dt>Version</dt>
              <dd className="text-foreground">
                {status.version}
                {status.latestVersion && status.version !== status.latestVersion ? ` (latest ${status.latestVersion})` : ''}
              </dd>
            </div>
          )}
          {kind === 'collector' && status.notes > 0 && (
            <div className="flex justify-between gap-2">
              <dt>Notes</dt>
              <dd className="text-foreground">{status.notes}</dd>
            </div>
          )}
        </dl>
        {fix && canFix && onFix && (
          <button
            type="button"
            onClick={() => onFix(fix)}
            className="mt-3 inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-md border border-input bg-background px-3 text-xs font-medium text-foreground hover:bg-accent"
          >
            {kind === 'ssh' ? <Download className="h-3.5 w-3.5" /> : <RefreshCw className="h-3.5 w-3.5" />}
            {fix.label}
          </button>
        )}
        {fix && !canFix && (
          <p className="mt-2 text-[11px] italic text-muted-foreground">Someone who can onboard servers can fix this.</p>
        )}
      </PopoverContent>
    </Popover>
  );
}

/**
 * @param {object} server   list row carrying `sshTrust`
 * @param {(fix: {scope}) => void} [onFix]  opens the installer for this host
 */
export function SshTrustBadge({ server, onFix, canFix }) {
  return <StatusBadge kind="ssh" status={server?.sshTrust} onFix={onFix} canFix={canFix} />;
}

/** @param {object} server  list row carrying `collector` */
export function CollectorBadge({ server, onFix, canFix }) {
  return <StatusBadge kind="collector" status={server?.collector} onFix={onFix} canFix={canFix} />;
}

// Tones per state, matching serverAgentStatus.js — for places that have a
// state but not a server row (a group header).
const SSH_TRUST_TONES = {
  healthy: 'success',
  legacy_token: 'warning',
  stale: 'warning',
  no_heartbeat: 'warning',
  installing: 'info',
  failed: 'danger',
  not_installed: 'warning',
  identity_auth: 'neutral',
  not_applicable: 'neutral',
};
const COLLECTOR_TONES = {
  reporting: 'success',
  outdated: 'info',
  degraded: 'danger',
  awaiting_report: 'info',
  rejected: 'danger',
  stale: 'warning',
  not_installed: 'neutral',
  not_applicable: 'neutral',
};

/**
 * A plain status badge from a state + label, no popover — for a group
 * header, which is itself a button.
 */
export function AgentStateBadge({ kind, state, label }) {
  const tone = (kind === 'ssh' ? SSH_TRUST_TONES : COLLECTOR_TONES)[state] || 'neutral';
  return (
    <Badge tone={tone} dot className="whitespace-nowrap">
      {label}
    </Badge>
  );
}

/** Filter options for the two columns, in the order a person scans them. */
export const SSH_TRUST_FILTER_OPTIONS = [
  { value: '', label: 'Any SSH trust' },
  { value: 'healthy', label: 'Healthy' },
  { value: 'legacy_token', label: 'Legacy token' },
  { value: 'stale', label: 'Agent silent' },
  { value: 'no_heartbeat', label: 'No heartbeat' },
  { value: 'failed', label: 'Install failed' },
  { value: 'installing', label: 'Installing' },
  { value: 'not_installed', label: 'Not installed' },
  { value: 'identity_auth', label: 'Identity auth' },
  { value: 'not_applicable', label: 'Not applicable' },
];

export const COLLECTOR_FILTER_OPTIONS = [
  { value: '', label: 'Any collector state' },
  { value: 'reporting', label: 'Reporting' },
  { value: 'outdated', label: 'Update available' },
  { value: 'degraded', label: 'Degraded' },
  { value: 'rejected', label: 'Reports refused' },
  { value: 'stale', label: 'Stopped reporting' },
  { value: 'awaiting_report', label: 'Waiting for report' },
  { value: 'not_installed', label: 'Not installed' },
  { value: 'not_applicable', label: 'Not applicable' },
];
