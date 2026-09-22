import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, History, Info, Pencil, Play, ShieldOff, Trash2, UsersRound, Zap } from 'lucide-react';
import { SectionCard } from '@/components/settings/shared';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import ConfirmDialog from '@/components/shared/ConfirmDialog';
import { relativeTime, formatDateTime } from '@/utils/time';
import {
  listDirectorySync,
  deleteDirectorySync,
  updateDirectorySync,
  runDirectorySync,
} from '@/services/directorySyncService';
import { useAuth } from '@/context/AuthContext';
import ProviderIcon from '../ProviderIcon';
import { getAdapterType, isArmed, modeBadge, activeBadge, runStatusBadge } from './adapterTypes';
import DirectorySyncConfigModal from './DirectorySyncConfigModal';
import DirectorySyncRunsModal from './DirectorySyncRunsModal';

function Notice({ tone = 'info', icon: Icon = Info, children }) {
  const tones = {
    info: 'border-blue-500/40 bg-blue-500/10 text-blue-700 dark:text-blue-300',
    warning: 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300',
    success: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
    danger: 'border-destructive/50 bg-destructive/10 text-destructive',
  };
  return (
    <div className={`flex items-start gap-2 rounded-md border px-3 py-2 text-sm ${tones[tone]}`}>
      <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function LastRunSummary({ sync }) {
  if (!sync.lastRunAt) return <p className="text-xs text-muted-foreground">Never run yet</p>;
  const badge = runStatusBadge(sync.lastRunStatus);
  return (
    <div className="space-y-1">
      <p className="text-xs text-muted-foreground" title={formatDateTime(sync.lastRunAt)}>
        Last run {relativeTime(sync.lastRunAt)} —{' '}
        <span
          className={
            badge.tone === 'danger'
              ? 'font-medium text-destructive'
              : badge.tone === 'warning'
                ? 'font-medium text-amber-700 dark:text-amber-400'
                : 'font-medium text-foreground'
          }
        >
          {badge.label}
        </span>
      </p>
      {sync.lastRunStatus === 'aborted' && (
        <p className="text-xs text-amber-700 dark:text-amber-400">Nothing was changed — the run refused to act.</p>
      )}
      {sync.lastRunStatus === 'failed' && sync.lastError && (
        <p className="text-xs text-destructive">{sync.lastError}</p>
      )}
    </div>
  );
}

function SafetySummary({ sync }) {
  if (sync.action !== 'suspend') {
    return <p className="text-xs text-muted-foreground">Flags matches for review only — nobody is suspended automatically.</p>;
  }
  return (
    <p className="text-xs text-muted-foreground">
      Suspends up to {sync.maxSuspendPercent}% (max {sync.maxSuspendCount}) per run, only after a {sync.graceHours}h grace period.
    </p>
  );
}

function EntryCard({ entry, onConfigure, onEdit, onDelete, onToggleActive, onRun, onViewRuns, runningId }) {
  const { ssoConfigId, name, presetId, supportedAdapter, unsupportedReason, sync } = entry;
  const adapterDef = getAdapterType(sync?.adapter || supportedAdapter);
  const running = runningId === ssoConfigId;

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border bg-muted/40">
          <ProviderIcon presetId={presetId} className="h-4 w-4 text-foreground" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="truncate text-sm font-semibold text-foreground">{name}</p>
            {sync ? (
              <>
                <Badge tone="neutral" variant="outline">
                  {adapterDef?.label || sync.adapterLabel || sync.adapter}
                </Badge>
                <Badge tone={activeBadge(sync).tone} dot>
                  {activeBadge(sync).label}
                </Badge>
                <Badge tone={modeBadge(sync).tone}>{modeBadge(sync).label}</Badge>
              </>
            ) : supportedAdapter ? (
              <Badge tone="neutral" variant="outline">
                Not configured
              </Badge>
            ) : (
              <Badge tone="neutral" variant="outline">
                No directory API
              </Badge>
            )}
          </div>

          {!supportedAdapter ? (
            <p className="mt-1.5 text-xs text-muted-foreground">{unsupportedReason || 'This provider has no directory API to sync against.'}</p>
          ) : !sync ? (
            <p className="mt-1.5 text-xs text-muted-foreground">
              Not set up — accounts that leave {adapterDef?.label || 'the directory'} won't be flagged automatically.
            </p>
          ) : (
            <div className="mt-1.5 space-y-1">
              <LastRunSummary sync={sync} />
              {/* GitHub can only answer "are they still in the org?", so an
                  account that exists but is disabled is invisible to it. Say
                  so, rather than letting it read as full coverage. */}
              {sync.reportsDisabled === false && (
                <p className="text-xs text-muted-foreground">
                  Reports accounts that have left only — this directory cannot tell Shellius that an account still exists but
                  has been disabled.
                </p>
              )}
              <SafetySummary sync={sync} />
            </div>
          )}
        </div>
      </div>

      {supportedAdapter && (
        <div className="mt-3 flex flex-wrap gap-2 border-t border-border pt-3">
          {!sync ? (
            <Button size="sm" onClick={() => onConfigure(entry)}>
              Set up directory sync
            </Button>
          ) : (
            <>
              <Button size="sm" variant="outline" onClick={() => onRun(entry)} disabled={running || !sync.isActive}>
                <Play className="mr-1.5 h-3.5 w-3.5" />
                {running ? 'Running…' : 'Run now'}
              </Button>
              <Button size="sm" variant="outline" onClick={() => onViewRuns(entry)}>
                <History className="mr-1.5 h-3.5 w-3.5" />
                Runs &amp; findings
              </Button>
              <Button size="sm" variant="ghost" onClick={() => onEdit(entry)}>
                <Pencil className="mr-1.5 h-3.5 w-3.5" />
                Edit
              </Button>
              <Button size="sm" variant="ghost" onClick={() => onToggleActive(entry)}>
                {sync.isActive ? (
                  <>
                    <ShieldOff className="mr-1.5 h-3.5 w-3.5" />
                    Disable
                  </>
                ) : (
                  <>
                    <Zap className="mr-1.5 h-3.5 w-3.5" />
                    Enable
                  </>
                )}
              </Button>
              <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => onDelete(entry)}>
                <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                Delete
              </Button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Directory sync — Settings → Single sign-on. Per configured SSO provider,
 * checks that provider's own directory (Entra, Okta, Google Workspace,
 * GitHub org) and flags, or — once armed — suspends, Shellius accounts whose
 * person is gone there. The only feature that can disable an account
 * without a human deciding to, so every state here is spelled out rather
 * than reduced to a color: dry run vs armed, aborted vs failed, and what a
 * run actually matched.
 */
export default function DirectorySyncSection() {
  const { user } = useAuth();
  const canManage = user?.permissions?.includes('settings.sso');

  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [flash, setFlash] = useState(null);

  const [configuring, setConfiguring] = useState(null); // entry being configured/edited, or null
  const [viewingRuns, setViewingRuns] = useState(null); // entry whose runs modal is open, or null
  const [confirm, setConfirm] = useState(null); // { kind: 'delete' | 'disable' | 'run', entry }
  const [runningId, setRunningId] = useState(null);

  const refresh = useCallback(() => {
    if (!canManage) return Promise.resolve();
    setLoading(true);
    return listDirectorySync()
      .then((list) => {
        setEntries(list || []);
        setError('');
      })
      .catch((err) => setError(err?.response?.data?.error?.message || err.message || 'Failed to load directory sync'))
      .finally(() => setLoading(false));
  }, [canManage]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  if (!canManage) return null;

  const runAction = async (fn, successMessage) => {
    setError('');
    try {
      await fn();
      if (successMessage) setFlash({ tone: 'success', message: successMessage });
      await refresh();
    } catch (err) {
      setError(err?.response?.data?.error?.message || err.message || 'Action failed');
    }
  };

  const doRun = async (entry) => {
    setRunningId(entry.ssoConfigId);
    setError('');
    try {
      const run = await runDirectorySync(entry.sync.id);
      const badgeLabel = run?.status === 'ok' ? 'completed' : run?.status === 'aborted' ? 'aborted — nothing changed' : run?.status || 'finished';
      setFlash({
        tone: run?.status === 'failed' ? 'danger' : run?.status === 'aborted' ? 'warning' : 'success',
        message: `${entry.name}: run ${badgeLabel}.`,
      });
    } catch (err) {
      setError(err?.response?.data?.error?.message || err.message || 'Run failed');
    } finally {
      setRunningId(null);
      refresh();
    }
  };

  const handleRun = (entry) => {
    if (isArmed(entry.sync)) {
      setConfirm({ kind: 'run', entry });
    } else {
      doRun(entry);
    }
  };

  const handleToggleActive = (entry) => {
    if (entry.sync.isActive) {
      setConfirm({ kind: 'disable', entry });
    } else {
      runAction(() => updateDirectorySync(entry.sync.id, { isActive: true }), `${entry.name}: directory sync enabled.`);
    }
  };

  const handleConfirm = async () => {
    const { kind, entry } = confirm || {};
    setConfirm(null);
    if (kind === 'delete') {
      await runAction(() => deleteDirectorySync(entry.sync.id), `${entry.name}: directory sync removed.`);
    } else if (kind === 'disable') {
      await runAction(() => updateDirectorySync(entry.sync.id, { isActive: false }), `${entry.name}: directory sync disabled.`);
    } else if (kind === 'run') {
      await doRun(entry);
    }
  };

  const confirmCopy = (() => {
    if (!confirm) return {};
    const { kind, entry } = confirm;
    const sync = entry?.sync;
    if (kind === 'delete') {
      return {
        title: `Remove directory sync for ${entry.name}?`,
        message: 'Its configuration, run history and open findings are removed. This cannot be undone.',
        confirmLabel: 'Remove',
        variant: 'destructive',
      };
    }
    if (kind === 'disable') {
      return {
        title: `Disable directory sync for ${entry.name}?`,
        message: 'Scheduled checks stop immediately. Turning it back on resumes on its normal schedule.',
        confirmLabel: 'Disable',
        variant: 'destructive',
      };
    }
    return {
      title: `Run directory sync for ${entry.name} now?`,
      message: sync
        ? `This is armed — dry run is off and Action is "Suspend automatically". Running now can suspend matching accounts for real, subject to the safety limits (up to ${sync.maxSuspendPercent}% or ${sync.maxSuspendCount} accounts, after a ${sync.graceHours}h grace period).`
        : '',
      confirmLabel: 'Run now',
      variant: 'destructive',
    };
  })();

  return (
    <SectionCard
      title="Directory sync"
      description="Check each provider's own directory and flag, or automatically suspend, accounts whose person has left or been disabled there."
    >
      <div className="space-y-4">
        <Notice tone="info" icon={UsersRound}>
          Dry run is on by default for a new configuration — it only reports what it would do. Nothing is suspended until dry run is
          switched off and Action is set to Suspend automatically, and that transition always asks for confirmation first.
        </Notice>

        {flash && (
          <Notice tone={flash.tone} icon={flash.tone === 'success' ? CheckCircle2 : AlertTriangle}>
            {flash.message}
          </Notice>
        )}
        {error && (
          <Notice tone="danger" icon={AlertTriangle}>
            {error}
          </Notice>
        )}

        {loading ? (
          <div className="space-y-2 py-2">
            {[1, 2].map((i) => (
              <div key={i} className="h-28 animate-pulse rounded-lg bg-muted" />
            ))}
          </div>
        ) : entries.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border px-6 py-10 text-center">
            <UsersRound className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
            <p className="text-sm font-medium text-foreground">No SSO providers yet</p>
            <p className="max-w-md text-xs text-muted-foreground">Add a sign-in provider above before setting up directory sync.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {entries.map((entry) => (
              <EntryCard
                key={entry.ssoConfigId}
                entry={entry}
                runningId={runningId}
                onConfigure={setConfiguring}
                onEdit={setConfiguring}
                onDelete={(e) => setConfirm({ kind: 'delete', entry: e })}
                onToggleActive={handleToggleActive}
                onRun={handleRun}
                onViewRuns={setViewingRuns}
              />
            ))}
          </div>
        )}
      </div>

      <DirectorySyncConfigModal
        open={!!configuring}
        onClose={() => setConfiguring(null)}
        entry={configuring}
        onSaved={() => {
          setConfiguring(null);
          setFlash({ tone: 'success', message: `${configuring?.name || 'Directory sync'}: configuration saved.` });
          refresh();
        }}
      />

      <DirectorySyncRunsModal open={!!viewingRuns} onClose={() => setViewingRuns(null)} entry={viewingRuns} />

      <ConfirmDialog
        open={!!confirm}
        title={confirmCopy.title}
        message={confirmCopy.message}
        confirmLabel={confirmCopy.confirmLabel}
        variant={confirmCopy.variant}
        onConfirm={handleConfirm}
        onCancel={() => setConfirm(null)}
      />
    </SectionCard>
  );
}
