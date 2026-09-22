import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronRight, Radar, ServerOff, ShieldAlert, ShieldCheck } from 'lucide-react';
import Skeleton from '@/components/ui/Skeleton';
import SeverityBadge from '@/components/posture/SeverityBadge';
import { SectionTitle, ViewAllLink } from '@/components/mobile/MobileNavList';
import { MobileCard } from '@/components/mobile/MobileCard';
import { severityAccent } from '@/lib/mobileCard';
import useIsMobile from '@/hooks/useIsMobile';
import { getPostureSummary, listFindings } from '@/services/postureService';
import { POSTURE_ALERTS_EVENT } from '@/hooks/usePostureAlertCount';
import { relativeTime } from '@/utils/time';
import { cn } from '@/lib/utils';

/**
 * Needs attention — the posture widget on the dashboard.
 *
 * It was a metric card, which could only ever show one number. That number
 * was the least useful part: "1 critical finding" tells you to go somewhere
 * else and start looking. A widget has room to say WHICH findings and on
 * which hosts, so the dashboard answers the question instead of forwarding
 * it.
 *
 * Coverage sits in the same widget rather than a tile of its own, because
 * "0 critical" across a fleet where most hosts are not reporting is the one
 * number on this page that reads as good news while meaning the opposite.
 * The two belong next to each other or not at all.
 */

const ROW_LIMIT = 4;

/** A clickable count. Zero is still worth showing — it is the reassurance. */
function Stat({ icon: Icon, label, value, tone, onClick, loading }) {
  const TONES = {
    danger: 'text-red-600 dark:text-red-400',
    warning: 'text-amber-600 dark:text-amber-400',
    muted: 'text-muted-foreground',
  };
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      className={cn(
        'flex min-w-0 flex-1 items-center gap-2.5 rounded-lg border border-border bg-background/40 px-3 py-2.5 text-left transition-colors',
        onClick && 'hover:border-primary/40 hover:bg-accent/40'
      )}
    >
      <Icon className={cn('h-4 w-4 shrink-0', TONES[tone] || TONES.muted)} aria-hidden="true" />
      <span className="min-w-0">
        {loading ? (
          <Skeleton className="h-5 w-8" />
        ) : (
          <span className="block text-lg font-semibold leading-tight tabular-nums text-foreground">{value}</span>
        )}
        <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">{label}</span>
      </span>
    </button>
  );
}

function NeedsAttentionWidget({ onInstall, refreshKey = 0 }) {
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const [summary, setSummary] = useState(null);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const loadedRef = useRef(false);

  const load = useCallback(async () => {
    if (!loadedRef.current) setLoading(true);
    try {
      const s = await getPostureSummary();
      setSummary(s);
      window.dispatchEvent(
        new CustomEvent(POSTURE_ALERTS_EVENT, {
          detail: (s?.findings?.critical || 0) + (s?.findings?.high || 0),
        })
      );

      // Worst first, and only as many as the widget shows. The list API
      // orders by last-seen, not severity, so asking for "the worst four"
      // means asking for criticals and topping up with highs — two bounded
      // requests rather than pulling a page and hoping the criticals are in
      // it.
      const critical = await listFindings({ section: 'open', severity: 'critical', limit: ROW_LIMIT });
      let items = critical.findings || [];
      if (items.length < ROW_LIMIT && (s?.findings?.high || 0) > 0) {
        const high = await listFindings({
          section: 'open',
          severity: 'high',
          limit: ROW_LIMIT - items.length,
        });
        items = [...items, ...(high.findings || [])];
      }
      setRows(items.slice(0, ROW_LIMIT));
    } catch {
      /* The dashboard degrades to its other widgets rather than erroring. */
    } finally {
      setLoading(false);
      loadedRef.current = true;
    }
  }, []);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, refreshKey]);

  const critical = summary?.findings?.critical ?? 0;
  const high = summary?.findings?.high ?? 0;
  // Refused hosts are as unmonitored as silent ones: their data stopped
  // updating even though the collector is running.
  const unmonitored =
    (summary?.servers?.notInstalled ?? 0) + (summary?.servers?.stale ?? 0) + (summary?.servers?.rejected ?? 0);
  // Hosts that CAN run the collector. Windows and RDP-only hosts are excluded
  // by the API, because "3 of 32 reporting" on a fleet with twelve Windows
  // boxes reads as a backlog and is really a ceiling.
  const totalServers = summary?.servers?.total ?? 0;
  const clean = !loading && critical === 0 && high === 0;

  const openFinding = (f) =>
    navigate(f.server?.id ? `/servers/${f.server.id}?tab=findings` : '/posture');

  const stats = (
    <div className="flex flex-wrap gap-2">
      <Stat
        icon={ShieldAlert}
        label="Critical"
        value={critical}
        tone="danger"
        loading={loading}
        onClick={() => navigate('/posture?severity=critical')}
      />
      <Stat
        icon={ShieldAlert}
        label="High"
        value={high}
        tone="warning"
        loading={loading}
        onClick={() => navigate('/posture?severity=high')}
      />
      <Stat
        icon={ServerOff}
        label={`Not reporting, of ${totalServers}`}
        value={unmonitored}
        tone={unmonitored > 0 ? 'warning' : 'muted'}
        loading={loading}
        onClick={() => navigate('/posture')}
      />
    </div>
  );

  const coverageNote = unmonitored > 0 && (
    <p className="flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-400">
      <Radar className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span>
        {unmonitored} of {totalServers} hosts are not reporting, so their exposure is{' '}
        <span className="font-medium">unknown, not clean</span>.{' '}
        {onInstall ? (
          <button
            type="button"
            onClick={onInstall}
            className="font-medium text-[hsl(var(--brand))] underline-offset-2 hover:underline"
          >
            Install collectors
          </button>
        ) : (
          // No permission to onboard: name where it happens rather than
          // offering a button that would only fail.
          <span>Someone with onboarding rights can install the collector from Servers.</span>
        )}
      </span>
    </p>
  );

  const body = loading ? (
    <div className="space-y-2">
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3">
          <Skeleton className="h-5 w-16 rounded-full" />
          <Skeleton className="h-4 flex-1" />
        </div>
      ))}
    </div>
  ) : clean ? (
    <div className="flex items-center gap-2.5 rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-3 py-3 text-sm">
      <ShieldCheck className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
      <span className="text-foreground">
        {unmonitored > 0
          ? 'Nothing critical or high on the hosts that are reporting.'
          : 'No critical or high findings across the fleet.'}
      </span>
    </div>
  ) : isMobile ? (
    <div className="grid auto-rows-fr gap-2">
      {rows.map((f) => (
        <MobileCard
          key={f.id}
          accent={severityAccent(f.severity)}
          titleClamp={2}
          title={f.message}
          secondary={
            <span className="font-mono">
              {f.code}
              {f.proto && f.port ? ` · ${f.proto}/${f.port}` : ''}
            </span>
          }
          meta={[
            <span key="server" className="truncate text-xs text-muted-foreground">
              {f.server?.displayName || f.server?.hostname || 'Unknown server'}
            </span>,
          ]}
          onClick={() => openFinding(f)}
        />
      ))}
    </div>
  ) : (
    <ul className="-mx-2 divide-y divide-border/60">
      {rows.map((f) => (
        <li key={f.id}>
          <button
            type="button"
            onClick={() => openFinding(f)}
            className="group flex w-full items-center gap-3 rounded-md px-2 py-2.5 text-left transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="shrink-0">
              <SeverityBadge severity={f.severity} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm text-foreground">{f.message}</span>
              <span className="mt-0.5 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                <span className="truncate font-medium text-foreground/80">
                  {f.server?.displayName || f.server?.hostname || 'Unknown server'}
                </span>
                <span className="truncate font-mono">
                  {f.code}
                  {f.proto && f.port ? ` · ${f.proto}/${f.port}` : ''}
                </span>
                <span className="whitespace-nowrap">{relativeTime(f.lastSeenAt)}</span>
              </span>
            </span>
            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/50 transition-colors group-hover:text-muted-foreground" />
          </button>
        </li>
      ))}
    </ul>
  );

  return (
    // Phones: no frame — its rows are cards themselves, same as the other
    // dashboard widgets.
    <div className="flex flex-col rounded-lg border border-border bg-card p-5 max-md:rounded-none max-md:border-0 max-md:bg-transparent max-md:p-0">
      {isMobile ? (
        <SectionTitle title="Needs attention" action={<ViewAllLink to="/posture" />} />
      ) : (
        <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold text-foreground">Needs attention</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Critical and high exposure findings across your fleet
            </p>
          </div>
          <button
            type="button"
            onClick={() => navigate('/posture')}
            className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md px-2 text-xs font-medium text-[hsl(var(--brand))] hover:bg-accent"
          >
            View all <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      <div className="space-y-3">
        {stats}
        {coverageNote}
        {body}
      </div>
    </div>
  );
}

export default NeedsAttentionWidget;
