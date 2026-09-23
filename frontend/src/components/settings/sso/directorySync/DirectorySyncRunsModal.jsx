import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Info, PackageOpen, UserX } from 'lucide-react';
import Modal from '@/components/shared/Modal';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { listDirectorySyncRuns, listDirectorySyncFindings } from '@/services/directorySyncService';
import { formatDateTime, relativeTime } from '@/utils/time';
import {
  runStatusBadge,
  showIdentityCaveat,
  identityCaveatMessage,
  findingReasonLabel,
  findingStatusBadge,
  sinceLabel,
} from './adapterTypes';

const cn = (...parts) => parts.filter(Boolean).join(' ');

function TabButton({ active, onClick, children }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
        active ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground'
      )}
    >
      {children}
    </button>
  );
}

function Stat({ label, value }) {
  return (
    <span className="text-xs text-muted-foreground">
      {label} <span className="font-medium text-foreground">{value ?? 0}</span>
    </span>
  );
}

function RunRow({ run, adapterType }) {
  const badge = runStatusBadge(run.status);
  const caveat = showIdentityCaveat(run);
  return (
    <div
      className={cn(
        'rounded-lg border p-3',
        run.status === 'failed' ? 'border-destructive/40' : run.status === 'aborted' ? 'border-amber-500/40' : 'border-border'
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={badge.tone} dot>
          {badge.label}
        </Badge>
        <Badge tone={run.dryRun ? 'info' : 'neutral'} variant="outline">
          {run.dryRun ? 'Dry run' : 'Live'}
        </Badge>
        <span className="ml-auto text-xs text-muted-foreground" title={formatDateTime(run.startedAt)}>
          {relativeTime(run.startedAt)}
          {Number.isFinite(run.durationMs) ? ` · ${(run.durationMs / 1000).toFixed(1)}s` : ''}
        </span>
      </div>

      {run.status === 'aborted' && (
        <div className="mt-2 flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-700 dark:text-amber-300">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>
            <span className="font-medium">Nothing was changed.</span> This run refused to act and aborted:{' '}
            {run.abortReason || 'no reason recorded.'}
          </span>
        </div>
      )}
      {run.status === 'failed' && run.error && (
        <div className="mt-2 flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs leading-relaxed text-destructive">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>{run.error}</span>
        </div>
      )}

      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
        <Stat label="In directory" value={run.directoryCount} />
        <Stat label="Matched by id" value={run.matchedByExternalId} />
        <Stat label="Matched by email" value={run.matchedByEmail} />
        <Stat label="Unknown identity" value={run.unknownIdentities} />
        <Stat label="Candidates" value={run.candidates} />
        <Stat label="Flagged" value={run.flagged} />
        <Stat label="Suspended" value={run.suspended} />
        <Stat label="Skipped" value={run.skipped} />
      </div>

      {caveat && (
        <div className="mt-2 flex items-start gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>{identityCaveatMessage(adapterType)}</span>
        </div>
      )}
    </div>
  );
}

function FindingRow({ finding }) {
  const badge = findingStatusBadge(finding.status);
  const since = sinceLabel(finding.firstSeenAt);
  return (
    <div className="rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-foreground">{finding.user?.name || finding.user?.email || 'Unknown user'}</span>
        {finding.user?.email && finding.user?.name && (
          <span className="text-xs text-muted-foreground">{finding.user.email}</span>
        )}
        <Badge tone={badge.tone} className="ml-auto">
          {badge.label}
        </Badge>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        {findingReasonLabel(finding.reason)}
        {since ? ` — ${since}` : ''}
        {finding.user?.role ? ` · ${finding.user.role}` : ''}
      </p>
      {finding.outcome && (
        <p className="mt-1.5 flex items-start gap-1.5 text-xs italic text-muted-foreground">
          <UserX className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          {finding.outcome}
        </p>
      )}
    </div>
  );
}

/**
 * Run history + findings for one directory sync. Runs come first — what
 * actually happened when it checked — findings second: the standing list of
 * people currently missing or disabled, each with how long and, when the
 * system deliberately didn't act, why (`outcome`).
 *
 * Props: open, onClose, entry (directory-sync list entry with `sync`)
 */
export default function DirectorySyncRunsModal({ open, onClose, entry }) {
  const sync = entry?.sync;
  const [tab, setTab] = useState('runs');
  const [runs, setRuns] = useState([]);
  const [runsLoading, setRunsLoading] = useState(true);
  const [runsError, setRunsError] = useState('');

  const [findings, setFindings] = useState([]);
  const [findingsLoading, setFindingsLoading] = useState(true);
  const [findingsError, setFindingsError] = useState('');
  const [showResolved, setShowResolved] = useState(false);

  const refreshRuns = useCallback(() => {
    if (!sync?.id) return Promise.resolve();
    setRunsLoading(true);
    return listDirectorySyncRuns(sync.id, 20)
      .then((list) => {
        setRuns(list || []);
        setRunsError('');
      })
      .catch((err) => setRunsError(err.response?.data?.error?.message || err.message || 'Failed to load runs.'))
      .finally(() => setRunsLoading(false));
  }, [sync?.id]);

  const refreshFindings = useCallback(
    (resolved) => {
      if (!sync?.id) return Promise.resolve();
      setFindingsLoading(true);
      return listDirectorySyncFindings(sync.id, { status: resolved ? 'all' : 'open', limit: 100 })
        .then((list) => {
          setFindings(list || []);
          setFindingsError('');
        })
        .catch((err) => setFindingsError(err.response?.data?.error?.message || err.message || 'Failed to load findings.'))
        .finally(() => setFindingsLoading(false));
    },
    [sync?.id]
  );

  useEffect(() => {
    if (!open) return;
    setTab('runs');
    setShowResolved(false);
    refreshRuns();
    refreshFindings(false);
  }, [open, refreshRuns, refreshFindings]);

  if (!open) return null;

  return (
    <Modal open={open} onClose={onClose} title={`Directory sync — ${entry?.name || ''}`} size="lg">
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div role="tablist" className="inline-flex gap-1 rounded-lg border border-border p-0.5">
            <TabButton active={tab === 'runs'} onClick={() => setTab('runs')}>
              Runs
            </TabButton>
            <TabButton active={tab === 'findings'} onClick={() => setTab('findings')}>
              Findings
            </TabButton>
          </div>
          {tab === 'findings' && (
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              Include resolved
              <Switch
                size="sm"
                checked={showResolved}
                onCheckedChange={(v) => {
                  setShowResolved(v);
                  refreshFindings(v);
                }}
              />
            </label>
          )}
        </div>

        {tab === 'runs' ? (
          runsError ? (
            <div role="alert" className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {runsError}
            </div>
          ) : runsLoading ? (
            <div className="space-y-2">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-24 animate-pulse rounded-lg bg-muted" />
              ))}
            </div>
          ) : runs.length === 0 ? (
            <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border px-6 py-8 text-center">
              <PackageOpen className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
              <p className="text-sm text-muted-foreground">No runs yet.</p>
            </div>
          ) : (
            <div className="space-y-2">
              {runs.map((r) => (
                <RunRow key={r.id} run={r} adapterType={sync?.adapter} />
              ))}
            </div>
          )
        ) : findingsError ? (
          <div role="alert" className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {findingsError}
          </div>
        ) : findingsLoading ? (
          <div className="space-y-2">
            {[1, 2].map((i) => (
              <div key={i} className="h-16 animate-pulse rounded-lg bg-muted" />
            ))}
          </div>
        ) : findings.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border px-6 py-8 text-center">
            <PackageOpen className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
            <p className="text-sm text-muted-foreground">{showResolved ? 'No findings.' : 'No open findings — nobody currently looks missing or disabled.'}</p>
          </div>
        ) : (
          <div className="space-y-2">
            {findings.map((f) => (
              <FindingRow key={f.id} finding={f} />
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}
