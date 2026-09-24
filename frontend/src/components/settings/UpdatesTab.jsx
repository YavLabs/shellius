import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  RefreshCw,
  ExternalLink,
  CheckCircle2,
  ArrowUpCircle,
  AlertTriangle,
  Clock,
  Download,
  MonitorOff,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import EmptyState from '@/components/ui/EmptyState';
import EnvironmentBadge from '@/components/shared/EnvironmentBadge';
import { SectionCard, CopyButton } from '@/components/settings/shared';
import { PostureTile, PostureTileGrid } from '@/components/posture/PostureTiles';
import { getUpdateStatus, checkForUpdates, getCollectorVersions } from '@/services/updateService';
import { summarizeUpdateStatus, updateCommand } from '@/lib/updateStatus';
import { statusTone } from '@/lib/badgeTones';
import { relativeTime, formatDateTime } from '@/utils/time';
import { cn } from '@/lib/utils';

/**
 * Administration → Organization → Updates (settings.updates).
 *
 * Two independent questions, two cards: is THIS install current, and is the
 * fleet's collector current. Both are read-only by design — see the
 * comment on routes/updates.js. Applying an update is deliberately not a
 * button anywhere in here: it's a script a person runs on the host, after
 * backing up the database, and the UI's job stops at telling them the exact
 * command.
 */

// ---------------------------------------------------------------------------
// This installation
// ---------------------------------------------------------------------------

function InstallationCard() {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    return getUpdateStatus()
      .then(setStatus)
      .catch((err) => setError(err?.response?.data?.error?.message || err.message || 'Could not load update status'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleCheck = async () => {
    setChecking(true);
    setError('');
    try {
      setStatus(await checkForUpdates());
    } catch (err) {
      // The 5/15min limiter (checkLimiter in routes/updates.js) returns its
      // own message on a 429 — show that instead of a generic failure so
      // "why did nothing happen" has an answer on screen.
      setError(err?.response?.data?.error?.message || err.message || 'Could not check for updates');
    } finally {
      setChecking(false);
    }
  };

  const summary = summarizeUpdateStatus(status);
  const checksOff = status?.enabled === false;

  return (
    <SectionCard
      title="This installation"
      description="The Shellius version running here, and whether a newer release exists."
      actions={
        <Button variant="outline" size="sm" onClick={handleCheck} disabled={checking || loading || checksOff}>
          <RefreshCw className={cn('mr-1.5 h-3.5 w-3.5', checking && 'animate-spin')} aria-hidden="true" />
          {checking ? 'Checking…' : 'Check now'}
        </Button>
      }
    >
      {loading ? (
        <div className="space-y-2 py-2">
          {[1, 2].map((i) => (
            <div key={i} className="h-10 animate-pulse rounded bg-muted" />
          ))}
        </div>
      ) : (
        <div className="space-y-4">
          {error && (
            <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <Badge tone={summary.tone}>{summary.label}</Badge>
            <span className="text-xs text-muted-foreground">
              Running {status?.currentVersion || 'unknown'}
              {status?.latestVersion && !status?.updateAvailable ? ` · latest is ${status.latestVersion}` : ''}
            </span>
          </div>

          {/* Muted note, never a destructive alert — a disabled reason and a
              stale check-error both land here, deliberately understated. */}
          {summary.note && <p className="text-xs text-muted-foreground">{summary.note}</p>}

          {status?.updateAvailable && status?.latestVersion && (
            <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-3">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                {status.releaseName && <span className="font-medium text-foreground">{status.releaseName}</span>}
                {status.publishedAt && <span>published {formatDateTime(status.publishedAt)}</span>}
                {status.releaseUrl && (
                  <a
                    href={status.releaseUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-primary hover:underline"
                  >
                    Release notes
                    <ExternalLink className="h-3 w-3" aria-hidden="true" />
                  </a>
                )}
              </div>

              <div>
                <p className="mb-1 text-xs text-muted-foreground">
                  Run on the host to apply it. Run{' '}
                  <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">scripts/backup-db.sh</code> first
                  — there is no undo endpoint for this.
                </p>
                <div className="flex items-start gap-2">
                  <pre className="flex-1 overflow-x-auto rounded border border-border bg-muted/40 px-3 py-2 font-mono text-xs text-foreground">
                    {updateCommand(status.latestVersion)}
                  </pre>
                  <CopyButton text={updateCommand(status.latestVersion)} />
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------
// Collector versions across the fleet
// ---------------------------------------------------------------------------

function VersionBars({ versions, latestVersion }) {
  const max = Math.max(...versions.map((v) => v.count), 1);
  return (
    <div className="space-y-1.5">
      {versions.map((v) => (
        <div key={v.version || 'unknown'} className="flex items-center gap-2 text-xs">
          <span className="w-24 shrink-0 truncate font-mono text-foreground">{v.version || 'Unknown'}</span>
          <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
            <div
              className={cn('h-full rounded-full', v.outdated ? 'bg-amber-500' : 'bg-emerald-500')}
              style={{ width: `${Math.max((v.count / max) * 100, 4)}%` }}
            />
          </div>
          <span className="w-6 shrink-0 text-right tabular-nums text-muted-foreground">{v.count}</span>
          {v.version && v.version === latestVersion && (
            <Badge tone="success" variant="outline" className="shrink-0">
              Current
            </Badge>
          )}
        </div>
      ))}
    </div>
  );
}

function OutdatedRow({ host }) {
  const { tone, label } = statusTone(host.state);
  return (
    <Link
      to={`/servers/${host.id}`}
      className="flex min-w-0 items-center gap-3 rounded-lg border border-border px-3 py-2 transition-colors hover:border-primary/40 hover:bg-accent/40"
    >
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="truncate text-sm font-medium text-foreground">{host.displayName || host.hostname}</span>
          <Badge tone={tone} variant="outline" className="shrink-0">
            {label}
          </Badge>
        </div>
        <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 text-[11px] text-muted-foreground">
          {host.displayName && host.hostname && host.displayName !== host.hostname && (
            <>
              <span className="truncate font-mono">{host.hostname}</span>
              <span aria-hidden="true">·</span>
            </>
          )}
          {/* customer is null for hosts outside every customer scope the API returned. */}
          {host.customer?.name && (
            <>
              <span className="truncate">{host.customer.name}</span>
              <span aria-hidden="true">·</span>
            </>
          )}
          <span>last report {host.lastReportAt ? relativeTime(host.lastReportAt) : 'never'}</span>
        </div>
      </div>
      <EnvironmentBadge environment={host.environment} className="shrink-0" />
      <span className="shrink-0 font-mono text-xs text-muted-foreground">{host.version || 'unknown'}</span>
    </Link>
  );
}

function CollectorsCard() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    getCollectorVersions()
      .then(setData)
      .catch((err) => setError(err?.response?.data?.error?.message || err.message || 'Could not load collector versions'))
      .finally(() => setLoading(false));
  }, []);

  const totals = data?.totals;
  const versions = data?.versions || [];
  const outdated = data?.outdated || [];

  return (
    <SectionCard
      title="Collector versions"
      description="What version of the posture collector each host in the fleet is running."
    >
      {loading ? (
        <div className="space-y-2 py-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-10 animate-pulse rounded bg-muted" />
          ))}
        </div>
      ) : error ? (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : (
        <div className="space-y-5">
          {totals && (
            <div className="space-y-2">
              <PostureTileGrid>
                <PostureTile icon={CheckCircle2} label="Reporting" tint="text-emerald-500" value={totals.reporting} />
                <PostureTile icon={ArrowUpCircle} label="Update available" tint="text-amber-500" value={totals.outdated} />
                <PostureTile icon={AlertTriangle} label="Degraded" tint="text-orange-500" value={totals.degraded} />
                <PostureTile icon={Clock} label="Stopped reporting" tint="text-muted-foreground" value={totals.stale} />
                <PostureTile icon={Download} label="Not installed" tint="text-muted-foreground" value={totals.notInstalled} />
                <PostureTile
                  icon={MonitorOff}
                  label="Not applicable"
                  tint="text-muted-foreground"
                  value={totals.notApplicable}
                  title="Windows and RDP-only hosts, which cannot run the collector"
                />
              </PostureTileGrid>
              <p className="text-xs text-muted-foreground">
                Not applicable means Windows and RDP-only hosts — they cannot run the collector at all, which is a
                correct end state, not a gap.
              </p>
            </div>
          )}

          {versions.length > 0 && (
            <div>
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Versions reporting
              </p>
              <VersionBars versions={versions} latestVersion={data?.latestVersion} />
              {!data?.latestVersion && (
                <p className="mt-2 text-xs text-muted-foreground">
                  The shipped collector version could not be read on this install, so nothing above is marked current.
                </p>
              )}
            </div>
          )}

          <div>
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Behind the shipped version
            </p>
            {outdated.length > 0 ? (
              <div className="space-y-1.5">
                {outdated.map((host) => (
                  <OutdatedRow key={host.id} host={host} />
                ))}
              </div>
            ) : (
              <EmptyState
                icon={CheckCircle2}
                title="Every reporting collector is on the current version"
                description="No fleet-wide collector upgrade is needed right now."
              />
            )}
          </div>
        </div>
      )}
    </SectionCard>
  );
}

function UpdatesTab() {
  return (
    <div className="space-y-6">
      <InstallationCard />
      <CollectorsCard />
    </div>
  );
}

export default UpdatesTab;
