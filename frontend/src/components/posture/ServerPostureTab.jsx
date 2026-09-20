import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, Check, Cpu, Database, Download, Gauge, HardDrive, Info, Radar, ShieldAlert, ShieldCheck, ShieldOff, Volume1, VolumeX, Wifi } from 'lucide-react';
import DataTable from '@/components/shared/DataTable';
import { PostureTile, PostureTileGrid } from '@/components/posture/PostureTiles';
import { severityAccent } from '@/lib/mobileCard';
import ExpectableMarker from '@/components/posture/ExpectableMarker';
import FindingSection from '@/components/posture/FindingSection';
import { serviceLabel, canMarkExpected, partitionFindings } from '@/lib/postureLabels';

import SearchableSelect from '@/components/ui/SearchableSelect';
import FindingDetailModal from '@/components/posture/FindingDetailModal';
import ListenerDetailModal from '@/components/posture/ListenerDetailModal';
import ExportDialog from '@/components/posture/ExportDialog';
import ExpectedPortDialog from '@/components/posture/ExpectedPortDialog';
import { Button } from '@/components/ui/button';
import { can } from '@/lib/permissions';
import { useAuth } from '@/context/AuthContext';
import EmptyState from '@/components/ui/EmptyState';
import { Badge } from '@/components/ui/badge';
import SeverityBadge from '@/components/posture/SeverityBadge';
import FindingStatusBadge from '@/components/posture/FindingStatusBadge';
import MuteDialog from '@/components/posture/MuteDialog';
import Sparkline from '@/components/posture/Sparkline';
import useIsMobile from '@/hooks/useIsMobile';
import SectionHeading from '@/components/common/SectionHeading';
import { ViewAllLink } from '@/components/mobile/MobileNavList';
import { reachabilityTone } from '@/lib/badgeTones';
import { muteFinding, unmuteFinding, acknowledgeFinding, listExpectedPorts, removeExpectedPort } from '@/services/postureService';
import { relativeTime, formatDateTime } from '@/utils/time';

function StatRow({ label, children }) {
  return (
    <div className="flex items-start justify-between gap-4 py-1.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-sm text-foreground">{children ?? '-'}</span>
    </div>
  );
}

function GaugeCard({ icon: Icon, label, points, unit = '%', color, onClick }) {
  const fluid = useIsMobile();
  const last = [...points].reverse().find((v) => v !== null && v !== undefined && !Number.isNaN(v));
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      title={onClick ? `${label} history` : undefined}
      // Stacked on a phone, side by side from `sm`. Two gauges share a phone
      // row, which leaves no room for a 120px sparkline beside the number —
      // it used to push out past the card edge.
      className={`flex w-full flex-col gap-1.5 rounded-lg border border-border bg-card p-3 text-left sm:flex-row sm:items-center sm:justify-between sm:gap-3 sm:p-3.5 ${
        onClick ? 'transition-colors hover:border-primary/40 hover:bg-accent/40' : ''
      }`}
    >
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <Icon className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{label}</span>
        </div>
        <p className="mt-1 text-xl font-semibold tabular-nums text-foreground">
          {last !== undefined ? `${Math.round(last)}${unit}` : '—'}
        </p>
      </div>
      <div className="min-w-0 sm:shrink-0">
        <Sparkline
          points={points}
          max={unit === '%' ? 100 : Math.max(1, ...points.filter((v) => v != null))}
          color={color}
          fluid={fluid}
        />
      </div>
    </Tag>
  );
}

/**
 * The posture slices of Server Details (docs/posture/posture-spec.md §8):
 * the collector/firewall/resources summary on Overview, the findings inbox,
 * and the ports table.
 *
 * Server Details owns the fetch and passes the payload in, so the tab labels
 * can carry finding counts without every tab switch refetching it.
 *
 * @param {'overview'|'findings'|'ports'} props.view  which slice to render.
 */
/**
 * Every severity gets a tile, INFO included. It was left out as visual
 * noise, but "All findings" counts what the table shows — so the tiles read
 * 0+1+0+1 beside a total of 4 and looked broken. Tiles that do not add up
 * are worse than a tile nobody needs.
 */
/** Worst first, for the phone preview list. */
const SEVERITY_ORDER = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'];

/**
 * The findings inbox, as sections. Order matters: the queue first, then the
 * three states that are reference rather than work, then history.
 */
const FINDING_SECTION_META = [
  {
    key: 'open',
    title: 'Open',
    description: 'Not yet acknowledged, muted or declared expected.',
    tone: 'danger',
    defaultOpen: true,
  },
  {
    key: 'expected',
    title: 'Marked as expected',
    description: 'Ports someone declared public on purpose, kept so the inventory is complete.',
    tone: 'success',
  },
  {
    key: 'acknowledged',
    title: 'Acknowledged',
    description: 'Seen and accepted; escalation is stopped but the finding is still open.',
    tone: 'warning',
  },
  {
    key: 'muted',
    title: 'Muted',
    description: 'Deliberately out of sight until the mute expires.',
    tone: 'neutral',
  },
  {
    key: 'resolved',
    title: 'Resolved',
    description: 'No longer reported by the collector. Kept for history.',
    tone: 'neutral',
  },
];

const SEVERITY_TILES = [
  { key: 'CRITICAL', label: 'Critical', icon: ShieldAlert, tint: 'text-red-500' },
  { key: 'HIGH', label: 'High', icon: ShieldAlert, tint: 'text-orange-500' },
  { key: 'MEDIUM', label: 'Medium', icon: Radar, tint: 'text-amber-500' },
  { key: 'LOW', label: 'Low', icon: Info, tint: 'text-sky-500' },
  { key: 'INFO', label: 'Info', icon: Info, tint: 'text-muted-foreground' },
];


/**
 * What the posture section looks like before a collector exists: the real
 * layout, blurred and inert, with the install action on top.
 *
 * A plain empty state told you nothing was there; this shows the shape of
 * what you get, which is the actual argument for installing it. The blurred
 * layer is aria-hidden and pointer-events-none so it is decoration, not
 * content a screen reader or a stray click can reach.
 */
function PostureLocked({ title, description, actionLabel, onAction, children }) {
  return (
    <div className="relative overflow-hidden rounded-lg">
      <div className="pointer-events-none select-none blur-[6px] saturate-50 opacity-60" aria-hidden="true">
        {children}
      </div>
      <div className="absolute inset-0 flex items-center justify-center bg-background/40 p-4">
        <div className="max-w-md rounded-lg border border-border bg-card p-5 text-center shadow-lg">
          <Radar className="mx-auto h-6 w-6 text-muted-foreground" />
          <h3 className="mt-2 text-sm font-semibold text-foreground">{title}</h3>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{description}</p>
          {actionLabel && onAction && (
            <Button size="sm" className="mt-3" onClick={onAction}>
              <Download className="mr-1.5 h-4 w-4" />
              {actionLabel}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

/** Inert stand-in for the collector / firewall / resources block. */
function PostureSkeleton() {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {['Collector', 'Firewall'].map((t) => (
          <div key={t} className="rounded-lg border border-border bg-card">
            <div className="border-b border-border px-5 py-3">
              <h3 className="text-sm font-semibold text-foreground">{t}</h3>
            </div>
            <div className="space-y-2.5 px-5 py-4">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="flex items-center justify-between gap-6">
                  <span className="h-3 w-24 rounded bg-muted" />
                  <span className="h-3 w-20 rounded bg-muted" />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">
        {['CPU', 'Memory', 'Disk', 'Load (1m)'].map((label) => (
          <div key={label} className="rounded-lg border border-border bg-card p-3 sm:p-3.5">
            <span className="text-xs text-muted-foreground">{label}</span>
            <p className="mt-1 text-xl font-semibold text-foreground">--%</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function ServerPostureTab({
  serverId,
  view = 'findings',
  data,
  loading,
  error: loadError,
  onReload,
  canMute,
  authMode,
  canBootstrap,
  onBootstrap,
  onViewFindings,
  onViewPorts,
}) {
  const navigate = useNavigate();
  const isPhone = useIsMobile();
  const [actionError, setActionError] = useState('');
  const error = loadError || actionError;
  const setError = setActionError;
  const [busyId, setBusyId] = useState(null);
  const [muteTarget, setMuteTarget] = useState(null);
  // Row click opens the detail view; the row's … menu keeps the quick actions.
  const [detailFinding, setDetailFinding] = useState(null);
  const [detailListener, setDetailListener] = useState(null);
  const [selected, setSelected] = useState([]);
  const [exportDataset, setExportDataset] = useState(null); // 'findings' | 'listeners'
  const [expectedTargets, setExpectedTargets] = useState(null);
  const [expectedPorts, setExpectedPorts] = useState([]);
  // Outcome of the last expected-port save. The dialog closes on success, so
  // the confirmation has to live on the page — otherwise a successful save
  // looks identical to nothing happening.
  const [expectedNotice, setExpectedNotice] = useState('');
  // Findings view filters. Severity is driven by the metric cards as well as
  // the select, so they cannot disagree about what is on screen.
  // Only the queue is open on arrival; the rest are reference and open on
  // demand. Their counts are visible either way, which is the part tabs got
  // wrong — nothing on the page said a muted finding existed at all.
  const [openSections, setOpenSections] = useState({ open: true });
  const [severityFilter, setSeverityFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [codeFilter, setCodeFilter] = useState('');
  // Ports view filters.
  const [reachFilter, setReachFilter] = useState('');
  const [ownerKindFilter, setOwnerKindFilter] = useState('');
  const [portStateFilter, setPortStateFilter] = useState('');
  const { user } = useAuth();
  const canExport = can(user, 'posture.export');
  const canExpect = can(user, 'posture.expected_ports');
  const [muteSubmitting, setMuteSubmitting] = useState(false);
  const [muteError, setMuteError] = useState('');

  const fetch = onReload;

  const loadExpected = useCallback(() => {
    // Best-effort: the tab is still useful without it, and a viewer who
    // cannot read the list should not see an error banner over the findings.
    listExpectedPorts(serverId).then(setExpectedPorts).catch(() => setExpectedPorts([]));
  }, [serverId]);

  useEffect(() => {
    loadExpected();
  }, [loadExpected]);

  const handleAcknowledge = async (finding) => {
    setBusyId(finding.id);
    try {
      await acknowledgeFinding(finding.id);
      fetch();
    } finally {
      setBusyId(null);
    }
  };

  const handleUnmute = async (finding) => {
    setBusyId(finding.id);
    try {
      await unmuteFinding(finding.id);
      fetch();
    } finally {
      setBusyId(null);
    }
  };

  const handleMuteConfirm = async (payload) => {
    if (!muteTarget) return;
    setMuteSubmitting(true);
    setMuteError('');
    try {
      await muteFinding(muteTarget.id, payload);
      setMuteTarget(null);
      fetch();
    } catch (err) {
      setMuteError(err.response?.data?.error?.message || 'Failed to mute finding');
    } finally {
      setMuteSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-3">
        <div className="h-24 animate-pulse rounded-lg bg-muted" />
        <div className="h-48 animate-pulse rounded-lg bg-muted" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
        {error}
      </div>
    );
  }

  const collector = data?.collector;
  const snapshot = data?.snapshot;

  // Three distinct empty states (spec §9.14) — never a blank "no findings"
  // when the real story is "nothing has ever reported".
  if (!collector?.installed) {
    // Overview shows the shape of what posture would add, behind a blur.
    // The findings and ports tabs keep the plain empty state: there is no
    // layout worth previewing when the answer is "no data at all".
    if (view === 'overview') {
      const posture = authMode === 'credential';
      return (
        <PostureLocked
          title="Posture collector not installed"
          description={
            posture
              ? 'This host connects with a stored identity, not a Shellius certificate. The collector adds only itself and its own systemd timer — it changes nothing about how SSH authentication works here.'
              : 'This host has never sent a posture snapshot. Installing the collector reports its listening ports, firewall state and resource use within a few minutes.'
          }
          actionLabel={canBootstrap && onBootstrap ? (posture ? 'Install posture collector' : 'Bootstrap host') : null}
          onAction={canBootstrap && onBootstrap ? () => onBootstrap(posture ? 'posture' : 'full') : null}
        >
          <PostureSkeleton />
        </PostureLocked>
      );
    }

    // Credential-mode hosts connect with a stored identity, never a
    // bootstrap cert, so the "Host menu → Bootstrap host" item is hidden on
    // them (pages/ServerDetail.jsx). They can still get posture coverage
    // through the reduced posture-only installer (POST /api/bootstrap/token
    // { mode: 'posture' }), which never touches sshd, CA trust or
    // check-principals — that's the whole reassurance these hosts need.
    if (authMode === 'credential') {
      return (
        <EmptyState
          icon={Radar}
          title="Collector not installed on this host"
          description="This host connects with a stored identity, not a Shellius certificate. Installing the posture collector adds only the collector and its own systemd timer — it changes nothing about how SSH authentication works on this host."
          action={canBootstrap && onBootstrap ? { label: 'Install posture collector', onClick: () => onBootstrap('posture') } : undefined}
        />
      );
    }
    return (
      <EmptyState
        icon={Radar}
        title="Collector not installed on this host"
        description='This server has never sent a posture snapshot. Run the bootstrap command with "--upgrade" appended to install it — it starts reporting within a few minutes.'
        action={canBootstrap && onBootstrap ? { label: 'Bootstrap host', onClick: () => onBootstrap('full') } : undefined}
      />
    );
  }

  if (!snapshot) {
    return (
      <EmptyState
        icon={Radar}
        title="Waiting for the first snapshot"
        description="The collector is installed but hasn't reported yet. It reports on its own timer (5 minutes by default) — check back shortly."
      />
    );
  }

  const listeners = data.listeners || [];
  // Every finding, resolved included — the sections below need history too.
  const allFindings = data.findings || [];
  const findings = allFindings.filter((f) => f.status !== 'resolved');
  const sectioned = partitionFindings(allFindings);

  const severityCounts = findings.reduce((acc, f) => {
    acc[f.severity] = (acc[f.severity] || 0) + 1;
    return acc;
  }, {});

  // What the table shows. Counts on the cards stay whole-tab totals so the
  // numbers do not move when you filter by them — a card that recomputed to
  // match its own filter would always read as the full count.
  const matchesFilters = (f) =>
    (!severityFilter || f.severity === severityFilter) &&
    (!statusFilter || f.status === statusFilter) &&
    (!codeFilter || f.code === codeFilter);
  const visibleFindings = findings.filter(matchesFilters);
  const findingCodes = [...new Set(findings.map((f) => f.code))].sort();
  const filtersActive = !!(severityFilter || statusFilter || codeFilter);

  const selectedFindings = visibleFindings.filter((f) => selected.includes(f.id));
  // Marking a port expected only resolves exposure findings. A selection of
  // firewall or already-expected findings would come back unchanged, which
  // is exactly what "nothing happened" looks like.
  const expectableFindings = selectedFindings.filter(canMarkExpected);

  // Join each declaration against what is actually listening now. A port you
  // declared expected that nothing is serving is worth surfacing: the
  // declaration outlived the service, and it will silently cover whatever
  // binds that port next.
  // One row per port on this host.
  //
  // Listeners and expected-port declarations were two tables describing the
  // same thing, which made a port's real state something you had to assemble
  // by eye. They are one table now: every listener, plus any declaration with
  // nothing behind it — a declaration that outlived its service still matters,
  // because it will silently cover whatever binds that port next.
  const expectedFor = (proto, port) =>
    expectedPorts.find((e) => e.port === port && (e.proto === 'any' || e.proto === proto)) || null;

  const portRows = [
    ...listeners.map((l) => ({
      ...l,
      rowKey: l.id,
      listening: true,
      expected: expectedFor(l.proto, l.port),
      findings: findings.filter((f) => f.port === l.port && (!f.proto || f.proto === l.proto)),
    })),
    // Declarations with no matching listener, surfaced rather than hidden.
    ...expectedPorts
      .filter((e) => !listeners.some((l) => l.port === e.port && (e.proto === 'any' || l.proto === e.proto)))
      .map((e) => ({
        id: `expected-${e.id}`,
        rowKey: `expected-${e.id}`,
        proto: e.proto === 'any' ? 'tcp' : e.proto,
        port: e.port,
        bind: null,
        reachability: null,
        listening: false,
        expected: e,
        findings: [],
      })),
  ].sort((a, b) => a.port - b.port || String(a.proto).localeCompare(String(b.proto)));

  const staleExpected = portRows.filter((r) => r.expected && !r.listening).length;
  // Surfaced through the "Expected, not listening" filter option rather than
  // a second amber line under the host's own stale banner.

  const ownerKinds = [...new Set(portRows.map((r) => r.ownerKind).filter(Boolean))].sort();
  const visiblePorts = portRows.filter((r) => {
    if (reachFilter && r.reachability !== reachFilter) return false;
    if (ownerKindFilter && r.ownerKind !== ownerKindFilter) return false;
    if (portStateFilter === 'findings' && r.findings.length === 0) return false;
    if (portStateFilter === 'expected' && !r.expected) return false;
    if (portStateFilter === 'stale' && (r.listening || !r.expected)) return false;
    return true;
  });
  const portFiltersActive = !!(reachFilter || ownerKindFilter || portStateFilter);

  const handleBulkAcknowledge = async () => {
    setBusyId('bulk');
    try {
      // Sequential: each is an audited write, and a burst against a shared
      // API is a worse trade than a second of latency on a bulk action.
      for (const id of selected) await acknowledgeFinding(id);
      setSelected([]);
      fetch();
    } catch (err) {
      setError(err.response?.data?.error?.message || 'Failed to acknowledge findings');
    } finally {
      setBusyId(null);
    }
  };

  const bulkBar = (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-accent/30 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <span className="text-sm text-foreground">{selected.length} selected</span>
      <div className="flex flex-wrap items-center gap-2">
        {canMute && (
          <Button size="sm" onClick={() => setMuteTarget({ ids: selected })}>
            <VolumeX className="mr-1.5 h-4 w-4" /> Mute
          </Button>
        )}
        {canMute && (
          <Button variant="outline" size="sm" onClick={handleBulkAcknowledge} disabled={busyId === 'bulk'}>
            <Check className="mr-1.5 h-4 w-4" /> Acknowledge
          </Button>
        )}
        {canExpect && (
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              setExpectedTargets({
                targets: expectableFindings.map((f) => ({ port: f.port, proto: f.proto })),
                skipped: selectedFindings.length - expectableFindings.length,
              })
            }
            disabled={expectableFindings.length === 0}
            title={
              expectableFindings.length === 0
                ? 'None of the selected findings are port exposures — marking a port expected would not resolve them'
                : `Declare ${expectableFindings.length} port${expectableFindings.length === 1 ? '' : 's'} expected on this server`
            }
          >
            <ShieldCheck className="mr-1.5 h-4 w-4" />
            Mark expected
            {expectableFindings.length > 0 && expectableFindings.length !== selectedFindings.length && (
              <span className="ml-1 text-xs opacity-70">({expectableFindings.length})</span>
            )}
          </Button>
        )}
        <Button variant="outline" size="sm" onClick={() => setSelected([])}>
          Clear
        </Button>
      </div>
    </div>
  );
  const metrics = data.metrics || [];
  const cpu = metrics.map((m) => m.cpuPct ?? null);
  const mem = metrics.map((m) => m.memPct ?? null);
  const disk = metrics.map((m) => m.diskPct ?? null);
  const load = metrics.map((m) => m.load1 ?? null);

  // Both filter sets go in DataTable's own toolbar slot — the shared shape
  // every other grid uses. Rendered above the table instead, they sat on
  // their own row (misaligned against the search on desktop) and, on a
  // phone, became a column of full-width selects where every other list in
  // the app has a single "Filters" button opening a sheet.
  const findingFilterSlot = (
    <>
      <SearchableSelect
        className="w-[150px]"
        value={severityFilter}
        onChange={setSeverityFilter}
        options={[{ value: '', label: 'All severities' }, ...SEVERITY_TILES.map((t) => ({ value: t.key, label: t.label }))]}
        placeholder="All severities"
        searchable={false}
      />
      <SearchableSelect
        className="w-[150px]"
        value={statusFilter}
        onChange={setStatusFilter}
        options={[
          { value: '', label: 'All statuses' },
          { value: 'open', label: 'Open' },
          { value: 'acknowledged', label: 'Acknowledged' },
          { value: 'muted', label: 'Muted' },
        ]}
        placeholder="All statuses"
        searchable={false}
      />
      <SearchableSelect
        className="w-[190px]"
        value={codeFilter}
        onChange={setCodeFilter}
        options={[{ value: '', label: 'All types' }, ...findingCodes.map((c) => ({ value: c, label: c }))]}
        placeholder="All types"
      />
      {filtersActive && (
        <button
          type="button"
          onClick={() => { setSeverityFilter(''); setStatusFilter(''); setCodeFilter(''); }}
          className="text-xs text-primary hover:underline max-md:hidden"
        >
          Clear filters
        </button>
      )}
    </>
  );

  const portFilterSlot = (
    <>
      <SearchableSelect
        className="w-[170px]"
        value={reachFilter}
        onChange={setReachFilter}
        options={[
          { value: '', label: 'All reachability' },
          { value: 'INTERNET', label: 'Internet' },
          { value: 'LAN', label: 'LAN' },
          { value: 'FIREWALLED', label: 'Firewalled' },
          { value: 'LOOPBACK', label: 'Loopback' },
          { value: 'UNKNOWN', label: 'Unknown' },
        ]}
        placeholder="All reachability"
        searchable={false}
      />
      <SearchableSelect
        className="w-[150px]"
        value={ownerKindFilter}
        onChange={setOwnerKindFilter}
        options={[{ value: '', label: 'All owners' }, ...ownerKinds.map((k) => ({ value: k, label: k }))]}
        placeholder="All owners"
        searchable={false}
      />
      <SearchableSelect
        className="w-[180px]"
        value={portStateFilter}
        onChange={setPortStateFilter}
        options={[
          { value: '', label: 'All ports' },
          { value: 'findings', label: 'Has open findings' },
          { value: 'expected', label: 'Marked expected' },
          {
            value: 'stale',
            label: staleExpected > 0 ? `Expected, not listening (${staleExpected})` : 'Expected, not listening',
          },
        ]}
        placeholder="All ports"
        searchable={false}
      />
      {portFiltersActive && (
        <button
          type="button"
          onClick={() => {
            setReachFilter('');
            setOwnerKindFilter('');
            setPortStateFilter('');
          }}
          className="text-xs text-primary hover:underline max-md:hidden"
        >
          Clear filters
        </button>
      )}
    </>
  );

  const listenerColumns = [
    {
      key: 'port',
      label: 'Port',
      mobile: { slot: 'title', render: (r) => `${(r.proto || '').toUpperCase()}/${r.port}${r.containerPort && r.containerPort !== r.port ? ` → ${r.containerPort}` : ''}` },
      render: (r) => (
        <span className="font-mono text-sm">
          {(r.proto || '').toUpperCase()}/{r.port}
          {r.containerPort && r.containerPort !== r.port && (
            <span className="text-muted-foreground"> → {r.containerPort}</span>
          )}
        </span>
      ),
    },
    {
      key: 'bind',
      label: 'Bind',
      hideBelow: 'md',
      mobile: { slot: 'meta', order: 2, showLabel: true, render: (r) => (r.bind ? <span className="font-mono">{r.bind}</span> : null) },
      render: (r) => <span className="font-mono text-xs text-muted-foreground">{r.bind}</span>,
    },
    {
      key: 'reachability',
      label: 'Reachability',
      mobile: {
        slot: 'meta',
        order: 1,
        render: (r) =>
          r.listening ? (
            <Badge tone={reachabilityTone(r.reachability).tone}>{reachabilityTone(r.reachability).label}</Badge>
          ) : (
            <Badge tone="warning">Not listening</Badge>
          ),
      },
      render: (r) => {
        if (!r.listening) {
          return (
            <span className="text-xs text-amber-600 dark:text-amber-400">Not listening</span>
          );
        }
        const { tone, label } = reachabilityTone(r.reachability);
        return <Badge tone={tone}>{label}</Badge>;
      },
    },
    {
      key: 'service',
      label: 'Service',
      // Search what the cell actually shows, so "docker" or "pm2" finds the
      // rows the column now labels that way.
      searchAccessor: (r) => (r.listening ? serviceLabel(r).text : ''),
      // What is behind the port, then who owns it. "systemd unit" on its own
      // — the inferred label — said less than the card had room for, while
      // the owner sat in an unlabelled chip below reading like a second,
      // contradictory service name.
      mobile: {
        slot: 'secondary',
        render: (r) => {
          if (!r.listening) return 'Nothing listening on this port';
          const owner = r.ownerKind ? `${r.ownerKind}/${r.ownerName || '-'}` : null;
          const service = serviceLabel(r).text;
          return owner && owner !== service ? `${service} · ${owner}` : service;
        },
      },
      render: (r) => {
        if (!r.listening) return <span className="text-muted-foreground">—</span>;
        const { text, inferred } = serviceLabel(r);
        return (
          <span className={inferred ? 'text-muted-foreground' : 'text-foreground'} title={text}>
            {text}
          </span>
        );
      },
    },
    {
      key: 'owner',
      label: 'Owner',
      // Carried by the card's secondary line (see 'service') rather than a
      // chip that repeated it.
      mobile: 'hidden',
      render: (r) => (
        <div className="max-w-[14rem]">
          <p className="truncate text-sm text-foreground">
            {r.ownerKind ? `${r.ownerKind}/${r.ownerName || '-'}` : <span className="text-muted-foreground">Unattributed</span>}
          </p>
          {(r.ownerDetail || r.ownerUser) && (
            <p className="truncate text-[11px] text-muted-foreground">
              {[r.ownerDetail, r.ownerUser ? `user: ${r.ownerUser}` : null].filter(Boolean).join(' · ')}
            </p>
          )}
        </div>
      ),
    },
    {
      key: 'sourcePath',
      label: 'Source',
      hideBelow: 'lg',
      mobile: 'hidden',
      render: (r) => (
        <span className="max-w-[12rem] truncate font-mono text-[11px] text-muted-foreground" title={r.sourcePath}>
          {r.sourcePath || '-'}
        </span>
      ),
    },
    {
      key: 'status',
      label: 'Status',
      searchAccessor: (r) =>
        [...r.findings.map((f) => `${f.severity} ${f.code}`), r.expected ? `expected ${r.expected.note}` : '']
          .join(' ')
          .trim(),
      // First chip, not fourth: with the default three-chip cap the status —
      // the only thing on the row that says "look at this port" — was the
      // one being dropped.
      mobile: {
        slot: 'meta',
        order: 0,
        render: (r) =>
          r.findings.length === 0 && !r.expected ? null : (
            <span className="flex flex-wrap items-center gap-1">
              {r.findings.map((f) => (
                <SeverityBadge key={f.id} severity={f.severity} />
              ))}
              {r.expected && (
                <Badge tone="neutral" variant="outline">
                  Expected
                </Badge>
              )}
            </span>
          ),
      },
      render: (r) => (
        <div className="flex flex-wrap items-center gap-1.5">
          {/* Each finding is its own control: the row opens the listener, a
              badge opens that finding. stopPropagation keeps the two apart. */}
          {r.findings.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setDetailFinding(f);
              }}
              title={f.message}
              className="rounded focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <SeverityBadge severity={f.severity} />
            </button>
          ))}
          {r.expected && (
            <Badge
              tone="neutral"
              variant="outline"
              title={`Expected on this server: ${r.expected.note}${
                r.expected.createdBy?.name ? ` — ${r.expected.createdBy.name}` : ''
              }`}
            >
              Expected
            </Badge>
          )}
          {r.findings.length === 0 && !r.expected && <span className="text-muted-foreground">—</span>}
        </div>
      ),
    },
  ];

  const findingColumns = [
    {
      key: 'severity',
      label: 'Severity',
      className: 'w-28',
      mobile: 'hidden',
      render: (r) => <SeverityBadge severity={r.severity} />,
    },
    {
      key: 'finding',
      label: 'Finding',
      searchAccessor: (r) => `${r.message || ''} ${r.code || ''}`,
      // The card carried the message and nothing else identifying, so two
      // findings of the same kind on different ports were indistinguishable.
      // The code and port go on the second line, as on the desktop row.
      mobile: [
        { slot: 'title', render: (r) => r.message },
        {
          slot: 'secondary',
          key: 'finding-code',
          render: (r) => (
            <span className="flex min-w-0 items-center gap-1.5">
              <ExpectableMarker finding={r} />
              <span className="min-w-0 truncate font-mono">
                {r.code}
                {r.proto && r.port ? ` · ${r.proto}/${r.port}` : ''}
              </span>
            </span>
          ),
        },
      ],
      render: (r) => (
        <div>
          <p className="font-medium text-foreground">{r.message}</p>
          <p className="mt-0.5 flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
            <ExpectableMarker finding={r} />
            <span className="min-w-0 truncate">
              {r.code}
              {r.proto && r.port ? ` · ${r.proto}/${r.port}` : ''}
            </span>
          </p>
        </div>
      ),
    },
    {
      key: 'status',
      label: 'Status',
      mobile: { slot: 'meta', order: 0, render: (r) => <FindingStatusBadge status={r.status} /> },
      render: (r) => <FindingStatusBadge status={r.status} />,
    },
    {
      key: 'lastSeenAt',
      label: 'Last seen',
      hideBelow: 'md',
      mobile: { slot: 'meta', order: 1, render: (r) => `Since ${relativeTime(r.firstSeenAt)}` },
      render: (r) => (
        <span className="text-xs text-muted-foreground" title={formatDateTime(r.lastSeenAt)}>
          {relativeTime(r.lastSeenAt)}
        </span>
      ),
    },
    ...(canMute
      ? [
          {
            key: 'actions',
            label: '',
            className: 'w-10',
            actions: [
              {
                label: 'Acknowledge',
                icon: Check,
                onClick: handleAcknowledge,
                hidden: (r) => r.status !== 'open' || !!r.acknowledgedAt || busyId === r.id,
              },
              {
                label: 'Mute…',
                icon: VolumeX,
                onClick: (r) => setMuteTarget({ id: r.id }),
                hidden: (r) => r.status !== 'open',
              },
              {
                label: 'Unmute',
                icon: Volume1,
                onClick: handleUnmute,
                hidden: (r) => r.status !== 'muted' || busyId === r.id,
              },
            ],
          },
        ]
      : []),
  ];

  return (
    <div className="space-y-5">
      {/* Collector / snapshot status — a degraded or stale collector must be
          visible, never a silent "all clean". */}
      {collector.stale && (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-sm text-amber-800 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <p className="font-medium">This host stopped reporting</p>
            <p className="mt-0.5 text-xs text-amber-700/90 dark:text-amber-300/90">
              Last snapshot {relativeTime(collector.lastSeenAt)} ({formatDateTime(collector.lastSeenAt)}). Findings below
              are held at their last known state, not cleared — verify the collector timer / connectivity on the host.
            </p>
          </div>
        </div>
      )}
      {snapshot.collectorOk === false && (
        <div className="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2.5 text-sm text-destructive">
          <ShieldOff className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <p className="font-medium">Collector degraded</p>
            <p className="mt-0.5 text-xs opacity-90">
              {snapshot.degradedReason || 'The collector ran but could not fully inspect this host — treat this report as incomplete, not clean.'}
            </p>
          </div>
        </div>
      )}

      {view === 'overview' && (
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="rounded-lg border border-border bg-card">
          <div className="border-b border-border px-5 py-3">
            <h3 className="text-sm font-semibold text-foreground">Collector</h3>
          </div>
          <div className="px-5 py-4">
            <StatRow label="Status">
              {collector.stale ? (
                <Badge tone="warning">Stale</Badge>
              ) : snapshot.collectorOk === false ? (
                <Badge tone="danger">Degraded</Badge>
              ) : (
                <Badge tone="success" icon={ShieldCheck}>
                  Reporting
                </Badge>
              )}
            </StatRow>
            <StatRow label="Version">{collector.version || 'Unknown'}</StatRow>
            <StatRow label="Last snapshot">
              {collector.lastSeenAt ? `${relativeTime(collector.lastSeenAt)} · ${formatDateTime(collector.lastSeenAt)}` : '-'}
            </StatRow>
            <StatRow label="Collected at">{formatDateTime(snapshot.collectedAt)}</StatRow>
          </div>
        </div>

        <div className="rounded-lg border border-border bg-card">
          <div className="border-b border-border px-5 py-3">
            <h3 className="text-sm font-semibold text-foreground">Firewall</h3>
          </div>
          <div className="px-5 py-4">
            <StatRow label="Engine">
              {snapshot.firewall?.engine && snapshot.firewall.engine !== 'unknown' ? (
                <span className="uppercase">{snapshot.firewall.engine}</span>
              ) : (
                <span className="flex items-center gap-1.5 text-muted-foreground">
                  <Wifi className="h-3.5 w-3.5" /> No usable firewall data
                </span>
              )}
            </StatRow>
            <StatRow label="Active">{snapshot.firewall?.active === true ? 'Yes' : snapshot.firewall?.active === false ? 'No' : '-'}</StatRow>
            <StatRow label="Default incoming">{snapshot.firewall?.defaultIncoming || '-'}</StatRow>
          </div>
        </div>
      </div>
      )}

      {/* Phones get the lists here rather than behind tabs (see ServerDetail:
          a three-tab strip on a 360px screen is three truncated labels and a
          scroll gesture). Same shape as the Dashboard: a short preview with
          "View all" to the full, filterable list. */}
      {view === 'overview' && isPhone && (
        <section className="space-y-2">
          <SectionHeading
            title="Open findings"
            count={findings.length}
            action={onViewFindings ? <ViewAllLink onClick={onViewFindings} /> : null}
          />
          {/* Rendered even when empty: "no open findings" is a result worth
              stating on the page you check, not an absent section. */}
          {findings.length === 0 ? (
            <p className="rounded-lg border border-border bg-card px-3 py-4 text-center text-sm text-muted-foreground">
              This host is clean as of the last snapshot.
            </p>
          ) : (
          <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
            {[...findings]
              .sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity))
              .slice(0, 4)
              .map((f) => (
                <li key={f.id}>
                  <button
                    type="button"
                    onClick={() => setDetailFinding(f)}
                    className="flex w-full items-start gap-2.5 px-3 py-2.5 text-left active:bg-accent/40"
                  >
                    <span className="mt-0.5 shrink-0">
                      <SeverityBadge severity={f.severity} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="line-clamp-2 block text-sm text-foreground">{f.message}</span>
                      <span className="mt-0.5 block truncate font-mono text-[11px] text-muted-foreground">
                        {f.code}
                        {f.proto && f.port ? ` · ${f.proto}/${f.port}` : ''}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
          </ul>
          )}
        </section>
      )}

      {view === 'overview' && isPhone && portRows.length > 0 && (
        <section className="space-y-2">
          <SectionHeading
            title="Ports & services"
            count={portRows.length}
            action={onViewPorts ? <ViewAllLink onClick={onViewPorts} /> : null}
          />
          <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
            {/* Internet-facing first, then ports with findings: the preview
                shows the rows you would have scrolled to find. */}
            {[...portRows]
              .sort(
                (a, b) =>
                  (b.reachability === 'INTERNET') - (a.reachability === 'INTERNET') ||
                  b.findings.length - a.findings.length ||
                  a.port - b.port
              )
              .slice(0, 4)
              .map((r) => (
                <li key={r.rowKey}>
                  <button
                    type="button"
                    onClick={() => setDetailListener(r)}
                    className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left active:bg-accent/40"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block font-mono text-sm text-foreground">
                        {(r.proto || '').toUpperCase()}/{r.port}
                      </span>
                      <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                        {r.listening ? serviceLabel(r).text : 'Nothing listening on this port'}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-1">
                      {r.findings.slice(0, 2).map((f) => (
                        <SeverityBadge key={f.id} severity={f.severity} />
                      ))}
                      {r.listening && (
                        <Badge tone={reachabilityTone(r.reachability).tone}>
                          {reachabilityTone(r.reachability).label}
                        </Badge>
                      )}
                    </span>
                  </button>
                </li>
              ))}
          </ul>
        </section>
      )}

      {view === 'overview' && metrics.length > 0 && (
        <div>
          <SectionHeading
            className="mb-2"
            title="Resources (~24h)"
            action={
              <button
                type="button"
                onClick={() => navigate(`/servers/${serverId}/resources`)}
                className="text-xs text-primary hover:underline"
              >
                View history
              </button>
            }
          />
          {/* Two to a row on a phone, not one: four full-width gauge cards
              were a column of near-empty boxes with a sparkline stranded on
              the right of each. */}
          <div className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">
            <GaugeCard icon={Cpu} label="CPU" points={cpu} color="primary" onClick={() => navigate(`/servers/${serverId}/resources`)} />
            <GaugeCard icon={Gauge} label="Memory" points={mem} color="violet" onClick={() => navigate(`/servers/${serverId}/resources`)} />
            <GaugeCard icon={HardDrive} label="Disk" points={disk} color="amber" onClick={() => navigate(`/servers/${serverId}/resources`)} />
            <GaugeCard icon={Database} label="Load (1m)" points={load} unit="" color="emerald" onClick={() => navigate(`/servers/${serverId}/resources`)} />
          </div>
        </div>
      )}

      {view === 'findings' && expectedNotice && (
        <div className="flex items-start justify-between gap-3 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-800 dark:text-emerald-200">
          <span>{expectedNotice}</span>
          <button
            type="button"
            onClick={() => setExpectedNotice('')}
            className="shrink-0 text-xs underline underline-offset-2 opacity-80 hover:opacity-100"
          >
            Dismiss
          </button>
        </div>
      )}

      {view === 'findings' && (
      <div className="space-y-4">
        <PostureTileGrid className="lg:grid-cols-6">
          {/* "All" clears the severity filter rather than setting one, so the
              tiles are a single control with six positions instead of five
              toggles plus a hidden default. */}
          <PostureTile
            icon={Radar}
            label="All findings"
            value={findings.length}
            active={!severityFilter}
            onClick={() => setSeverityFilter('')}
          />
          {SEVERITY_TILES.map((t) => {
            const count = severityCounts[t.key] || 0;
            const active = severityFilter === t.key;
            return (
              <PostureTile
                key={t.key}
                icon={t.icon}
                tint={t.tint}
                label={t.label}
                value={count}
                active={active}
                disabled={count === 0 && !active}
                onClick={() => setSeverityFilter(active ? '' : t.key)}
              />
            );
          })}
        </PostureTileGrid>

        {allFindings.length === 0 ? (
          <EmptyState icon={ShieldCheck} title="No findings" description="This host is clean as of the last snapshot." />
        ) : (
          /* Sections, not tabs. Muted, acknowledged and expected findings
             used to be reachable only through a filter nobody thought to
             set, so a host with ten muted findings looked identical to one
             with none. Every count is on screen; only the queue is open. */
          <div className="space-y-2">
            {FINDING_SECTION_META.map((sec) => {
              const rows = sectioned[sec.key] || [];
              const visible = rows.filter(matchesFilters);
              return (
                <FindingSection
                  key={sec.key}
                  title={sec.title}
                  description={sec.description}
                  count={rows.length}
                  tone={sec.tone}
                  open={!!openSections[sec.key]}
                  onToggle={() => setOpenSections((p) => ({ ...p, [sec.key]: !p[sec.key] }))}
                >
                  {visible.length === 0 ? (
                    // A filtered view with nothing in it must never be
                    // mistaken for an empty section (spec §9.14).
                    <p className="py-6 text-center text-sm text-muted-foreground">
                      None of the {rows.length} finding{rows.length === 1 ? '' : 's'} here match the
                      current filters.
                    </p>
                  ) : (
                    <DataTable
                      columns={findingColumns}
                      data={visible}
                      filters={sec.key === 'open' ? findingFilterSlot : undefined}
                      activeFilterCount={[severityFilter, statusFilter, codeFilter].filter(Boolean).length}
                      onResetFilters={() => { setSeverityFilter(''); setStatusFilter(''); setCodeFilter(''); }}
                      toolbarActions={
                        canExport && sec.key === 'open' ? (
                          <Button variant="outline" size="sm" onClick={() => setExportDataset('findings')}>
                            <Download className="mr-1.5 h-4 w-4" /> Export
                          </Button>
                        ) : null
                      }
                      onRowClick={setDetailFinding}
                      showSearch={false}
                      emptyMessage="Nothing here"
                      selectable={canMute || canExpect}
                      selectedIds={selected}
                      onSelectionChange={setSelected}
                      bulkActions={bulkBar}
                      // Severity is the column the phone card drops, so it
                      // has to come back as the card's own colour —
                      // otherwise the one thing that ranks a finding is the
                      // one thing a phone never shows.
                      mobile={{ accent: (r) => severityAccent(r.severity), titleClamp: 2 }}
                    />
                  )}
                </FindingSection>
              );
            })}
          </div>
        )}
        {canExpect && allFindings.some(canMarkExpected) && (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-emerald-600/70 dark:text-emerald-400/70" aria-hidden="true" />
            marks a finding that <span className="font-medium text-foreground">Mark expected</span> can
            resolve. Mute and Acknowledge apply to every finding.
          </p>
        )}
      </div>
      )}

      {view === 'ports' && (
      <div>
        <DataTable
          columns={listenerColumns}
          data={visiblePorts}
          filters={portFilterSlot}
          toolbarActions={
            canExport && listeners.length > 0 ? (
              <Button variant="outline" size="sm" onClick={() => setExportDataset('listeners')}>
                <Download className="mr-1.5 h-4 w-4" /> Export
              </Button>
            ) : null
          }
          onRowClick={setDetailListener}
          showSearch={portRows.length > 8}
          searchPlaceholder="Search port, service, owner or status..."
          emptyMessage={portFiltersActive ? 'No ports match these filters' : 'No listening ports reported'}
          // Tint only, no corner label: the reachability chip already says
          // INTERNET, and the card was printing it twice.
          mobile={{ accent: (r) => (r.reachability === 'INTERNET' ? { tone: 'danger' } : null) }}
        />
        <p className="mt-2 text-xs text-muted-foreground">
          Every port this host is serving, plus any marked expected. A severity badge opens that
          finding; a row opens the port. A port marked expected is not reported as exposed here —
          removing that does not reopen the finding immediately, it returns on the next snapshot if
          the port is still listening.
        </p>
      </div>
      )}

      <ExportDialog
        open={!!exportDataset}
        dataset={exportDataset || 'findings'}
        filters={{ serverId, ...(exportDataset === 'findings' ? { status: 'open' } : {}) }}
        scopeLabel={exportDataset === 'listeners' ? 'this server\u2019s listening ports' : 'this server\u2019s open findings'}
        onClose={() => setExportDataset(null)}
      />

      <ExpectedPortDialog
        open={!!expectedTargets}
        serverId={serverId}
        targets={expectedTargets?.targets || []}
        skipped={expectedTargets?.skipped || 0}
        onClose={() => setExpectedTargets(null)}
        onDone={(result) => {
          setExpectedTargets(null);
          setSelected([]);
          setExpectedNotice(
            `${result.added} port${result.added === 1 ? '' : 's'} marked as expected` +
              (result.skipped ? `, ${result.skipped} already were` : '') +
              `. ${result.resolvedFindings} finding${result.resolvedFindings === 1 ? '' : 's'} resolved.`
          );
          fetch();
          loadExpected();
        }}
      />

      <FindingDetailModal
        open={!!detailFinding}
        finding={detailFinding}
        onClose={() => setDetailFinding(null)}
        canMute={canMute}
        busy={busyId === detailFinding?.id}
        showServerLink={false}
        onAcknowledge={(f) => { setDetailFinding(null); handleAcknowledge(f); }}
        onMute={(f) => { setDetailFinding(null); setMuteTarget({ id: f.id }); }}
        onUnmute={(f) => { setDetailFinding(null); handleUnmute(f); }}
        canExpect={canExpect}
        onMarkExpected={(f) => {
          setDetailFinding(null);
          setExpectedTargets({ targets: [{ port: f.port, proto: f.proto }], skipped: 0 });
        }}
      />

      <ListenerDetailModal
        open={!!detailListener}
        listener={detailListener}
        findings={findings}
        canExpect={canExpect}
        onClose={() => setDetailListener(null)}
        onOpenFinding={(f) => { setDetailListener(null); setDetailFinding(f); }}
        onMarkExpected={(l) => {
          setDetailListener(null);
          setExpectedTargets({ targets: [{ port: l.port, proto: l.proto }], skipped: 0 });
        }}
        onRemoveExpected={async (entryId) => {
          await removeExpectedPort(serverId, entryId);
          setDetailListener(null);
          loadExpected();
          fetch();
        }}
      />

      <MuteDialog
        open={!!muteTarget}
        count={1}
        submitting={muteSubmitting}
        error={muteError}
        onConfirm={handleMuteConfirm}
        onCancel={() => { setMuteTarget(null); setMuteError(''); }}
      />
    </div>
  );
}

export default ServerPostureTab;
