import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Cpu, Database, Gauge, HardDrive, Info, RefreshCw } from 'lucide-react';
import PageHeader from '@/components/common/PageHeader';
import MobilePageHeader from '@/components/mobile/MobilePageHeader';
import MetricChart from '@/components/posture/MetricChart';
import EnvironmentBadge from '@/components/shared/EnvironmentBadge';
import SearchableSelect from '@/components/ui/SearchableSelect';
import EmptyState from '@/components/ui/EmptyState';
import useIsMobile from '@/hooks/useIsMobile';
import { getServerMetrics } from '@/services/postureService';
import { formatDateTime } from '@/utils/time';
import { cn } from '@/lib/utils';

/**
 * Server → Resources: the drill-down behind the posture tab's sparklines.
 *
 * The sparkline answers "what is it now"; this answers "what has it been",
 * which is the question that decides whether a number matters. 95% memory
 * for a minute is noise; 95% for three days is a capacity problem, and the
 * two look identical on a 24-hour sparkline.
 *
 * Bucketing and the aggregates both come from the API so the numbers under a
 * chart always describe the rows that chart drew — computing them here from
 * the bucketed series would quietly report the average of averages.
 */

const RANGES = [
  { key: '6h', label: '6 hours', ms: 6 * 60 * 60 * 1000 },
  { key: '24h', label: '24 hours', ms: 24 * 60 * 60 * 1000 },
  { key: '7d', label: '7 days', ms: 7 * 24 * 60 * 60 * 1000 },
  { key: '30d', label: '30 days', ms: 30 * 24 * 60 * 60 * 1000 },
  { key: 'custom', label: 'Custom' },
];

const BUCKETS = [
  { value: 'auto', label: 'Auto' },
  { value: 'raw', label: 'Every sample' },
  { value: '5m', label: '5 minutes' },
  { value: '15m', label: '15 minutes' },
  { value: '1h', label: '1 hour' },
  { value: '6h', label: '6 hours' },
  { value: '1d', label: '1 day' },
];

const METRICS = [
  { key: 'cpuPct', label: 'CPU', icon: Cpu, color: 'primary', unit: '%' },
  { key: 'memPct', label: 'Memory', icon: Gauge, color: 'violet', unit: '%' },
  { key: 'diskPct', label: 'Disk', icon: HardDrive, color: 'amber', unit: '%' },
  { key: 'load1', label: 'Load (1m)', icon: Database, color: 'emerald', unit: '' },
];

/** `datetime-local` wants a local-time string with no zone suffix. */
function toLocalInput(date) {
  const d = new Date(date);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function Stat({ label, value, unit }) {
  return (
    <div className="min-w-0">
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground/70">{label}</p>
      <p className="truncate text-sm font-semibold tabular-nums text-foreground">
        {value === null || value === undefined ? '—' : `${value.toFixed(unit === '%' ? 1 : 2)}${unit}`}
      </p>
    </div>
  );
}

function ServerResources() {
  const { id } = useParams();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const [params, setParams] = useSearchParams();

  const range = params.get('range') || '24h';
  const bucket = params.get('bucket') || 'auto';
  const customFrom = params.get('from') || '';
  const customTo = params.get('to') || '';

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const patch = (next) => {
    const merged = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) {
      if (v === null || v === '') merged.delete(k);
      else merged.set(k, v);
    }
    setParams(merged, { replace: true });
  };

  // The window to ask for. Custom uses the two inputs; everything else is
  // "now minus the preset", recomputed on each fetch so Refresh moves it.
  const window = useMemo(() => {
    if (range === 'custom') {
      if (!customFrom || !customTo) return null;
      return { from: new Date(customFrom).toISOString(), to: new Date(customTo).toISOString() };
    }
    const preset = RANGES.find((r) => r.key === range) || RANGES[1];
    const to = new Date();
    return { from: new Date(to.getTime() - preset.ms).toISOString(), to: to.toISOString() };
  }, [range, customFrom, customTo]);

  const fetchMetrics = useCallback(async () => {
    if (!window) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    try {
      setData(await getServerMetrics(id, { ...window, bucket }));
    } catch (err) {
      setError(err?.response?.data?.error?.message || err.message || 'Could not load resource history.');
    } finally {
      setLoading(false);
    }
  }, [id, window, bucket]);

  useEffect(() => {
    fetchMetrics();
  }, [fetchMetrics]);

  const server = data?.server;
  const title = server ? server.displayName || server.hostname : 'Resources';

  // Did we ask for more history than the org keeps? Saying so beats drawing a
  // chart that starts two days into a seven-day window with no explanation.
  const oldest = data?.retention?.oldestSampleAt ? new Date(data.retention.oldestSampleAt) : null;
  const askedBefore = window && oldest && new Date(window.from) < oldest;

  const seriesFor = (key) => (data?.series || []).map((p) => ({ at: p.at, value: p[key] }));

  const controls = (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {RANGES.map((r) => (
          <button
            key={r.key}
            type="button"
            onClick={() => patch({ range: r.key })}
            className={cn(
              'inline-flex h-8 items-center rounded-md border px-3 text-xs transition-colors',
              range === r.key
                ? 'border-primary bg-primary/10 text-foreground'
                : 'border-border text-muted-foreground hover:bg-accent'
            )}
          >
            {r.label}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Group by</span>
          <SearchableSelect
            className="w-[140px]"
            value={bucket}
            onChange={(v) => patch({ bucket: v })}
            options={BUCKETS}
            clearable={false}
          />
        </div>
      </div>

      {range === 'custom' && (
        <div className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-muted/20 p-3">
          <label className="text-xs text-muted-foreground">
            From
            <input
              type="datetime-local"
              value={customFrom || toLocalInput(Date.now() - 24 * 60 * 60 * 1000)}
              onChange={(e) => patch({ from: e.target.value })}
              className="mt-1 block h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </label>
          <label className="text-xs text-muted-foreground">
            To
            <input
              type="datetime-local"
              value={customTo || toLocalInput(Date.now())}
              onChange={(e) => patch({ to: e.target.value })}
              className="mt-1 block h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </label>
        </div>
      )}
    </div>
  );

  return (
    <div className="space-y-5 p-6 max-md:p-4">
      {isMobile ? (
        <MobilePageHeader
          back={{ onClick: () => navigate(`/servers/${id}?tab=posture`), label: 'Back to posture' }}
          title={title}
          subtitle="Resource history"
        />
      ) : (
        <>
          <button
            onClick={() => navigate(`/servers/${id}?tab=posture`)}
            className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" /> Back to posture
          </button>
          <PageHeader
            icon={Gauge}
            title={`${title} · Resources`}
            subtitle={
              server ? (
                <span className="flex items-center gap-2">
                  {server.environment && <EnvironmentBadge environment={server.environment} />}
                  <span className="text-muted-foreground">CPU, memory, disk and load over time.</span>
                </span>
              ) : (
                'CPU, memory, disk and load over time.'
              )
            }
            actions={[
              {
                key: 'refresh',
                label: 'Refresh',
                icon: RefreshCw,
                variant: 'outline',
                onClick: fetchMetrics,
                disabled: loading,
                spin: loading,
              },
            ]}
          />
        </>
      )}

      {controls}

      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {data && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span>
            {formatDateTime(data.range.from)} → {formatDateTime(data.range.to)}
          </span>
          <span>
            {data.series.length} point{data.series.length === 1 ? '' : 's'}
            {data.bucket !== 'raw' && ` · ${BUCKETS.find((b) => b.value === data.bucket)?.label || data.bucket} buckets`}
            {data.bucket === 'raw' && ' · every sample'}
          </span>
          <span>Collected every {Math.round((data.retention.collectIntervalSeconds || 300) / 60)} min</span>
        </div>
      )}

      {askedBefore && (
        <div className="flex items-start gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <p>
            <span className="font-medium text-foreground">Older data has been pruned.</span> This
            organization keeps resource samples for {data.retention.hours} hours, and the oldest one
            held for this host is from {formatDateTime(oldest)}. Raise the retention in
            Administration → Posture to chart a longer window in future — it cannot recover samples
            already deleted.
          </p>
        </div>
      )}

      {!loading && data && data.series.length === 0 && (
        <EmptyState
          icon={Gauge}
          title="No samples in this range"
          description="Either the collector was not reporting, or the samples for this window have been pruned."
        />
      )}

      {data && data.series.length > 0 && (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          {METRICS.map((m) => {
            const summary = data.summary?.[m.key];
            return (
              <div key={m.key} className="rounded-lg border border-border bg-card p-4">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <h3 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
                    <m.icon className="h-4 w-4 text-muted-foreground" />
                    {m.label}
                  </h3>
                  {summary && (
                    <span className="text-[11px] text-muted-foreground">
                      {summary.samples} sample{summary.samples === 1 ? '' : 's'}
                    </span>
                  )}
                </div>

                <MetricChart
                  points={seriesFor(m.key)}
                  color={m.color}
                  unit={m.unit}
                  formatTime={(t) => formatDateTime(t)}
                />

                <div className="mt-3 grid grid-cols-5 gap-2 border-t border-border pt-3">
                  <Stat label="Min" value={summary?.min} unit={m.unit} />
                  <Stat label="Avg" value={summary?.avg} unit={m.unit} />
                  <Stat label="p50" value={summary?.p50} unit={m.unit} />
                  <Stat label="p95" value={summary?.p95} unit={m.unit} />
                  <Stat label="Max" value={summary?.max} unit={m.unit} />
                </div>
              </div>
            );
          })}
        </div>
      )}

      {loading && !data && <p className="text-sm text-muted-foreground">Loading…</p>}
    </div>
  );
}

export default ServerResources;
