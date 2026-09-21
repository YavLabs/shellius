import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Check, Download, Eye, Info, Radar, RefreshCw, ServerOff, ShieldAlert, ShieldCheck, ShieldOff, Volume1, VolumeX } from 'lucide-react';
import DataTable from '@/components/shared/DataTable';
import PageHeader from '@/components/common/PageHeader';
import EmptyState from '@/components/ui/EmptyState';
import ServerName, { serverSearchString } from '@/components/shared/ServerName';
import EnvironmentBadge from '@/components/shared/EnvironmentBadge';
import SeverityBadge from '@/components/posture/SeverityBadge';
import FindingStatusBadge from '@/components/posture/FindingStatusBadge';
import FleetFindingsSection from '@/components/posture/FleetFindingsSection';
import FilterControl from '@/components/shared/FilterControl';
import MuteDialog from '@/components/posture/MuteDialog';
import CollectorCoverageModal from '@/components/posture/CollectorCoverageModal';
import FindingDetailModal from '@/components/posture/FindingDetailModal';
import ExportDialog from '@/components/posture/ExportDialog';
import ExpectedPortDialog from '@/components/posture/ExpectedPortDialog';
import { canMarkExpected } from '@/lib/postureLabels';
import ExpectableMarker from '@/components/posture/ExpectableMarker';
import { PostureTile, PostureTileGrid } from '@/components/posture/PostureTiles';
import BootstrapWizard from '@/components/servers/BootstrapWizard';
import BulkInstallModal from '@/components/servers/BulkInstallModal';
import BootstrapModal from '@/components/servers/BootstrapModal';
import ProvisionModal from '@/components/servers/ProvisionModal';
import { Button } from '@/components/ui/button';
import {
  getPostureSummary,
  muteFinding,
  unmuteFinding,
  acknowledgeFinding,
} from '@/services/postureService';
import { listCustomers } from '@/services/customerService';
import { useAuth } from '@/context/AuthContext';
import { can } from '@/lib/permissions';
import { severityAccent } from '@/lib/mobileCard';
import { POSTURE_ALERTS_EVENT } from '@/hooks/usePostureAlertCount';
import { relativeTime, formatDateTime } from '@/utils/time';
import { ENVIRONMENT_LABELS } from '@/lib/labels';

const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'];

/** Same order, icons and tints as the per-server tab, so the two read alike. */
const SEVERITY_TILES = [
  { key: 'critical', label: 'Critical', icon: ShieldAlert, tint: 'text-red-500' },
  { key: 'high', label: 'High', icon: ShieldAlert, tint: 'text-orange-500' },
  { key: 'medium', label: 'Medium', icon: Radar, tint: 'text-amber-500' },
  { key: 'low', label: 'Low', icon: Info, tint: 'text-sky-500' },
  { key: 'info', label: 'Info', icon: Info, tint: 'text-muted-foreground' },
];
const ENVIRONMENTS = ['demo', 'dev', 'staging', 'prod'];
/**
 * The inbox, as sections rather than tabs. Tabs made three of these four
 * views invisible: nothing on the page said a muted or acknowledged finding
 * existed, so the only way to remember them was to already know. Sections
 * put every count on screen and let the ones that are not a queue stay shut.
 */
const FINDING_SECTIONS = [
  {
    key: 'open',
    title: 'Open',
    description: 'Not yet acknowledged, muted or declared expected.',
    tone: 'danger',
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
    description: 'No longer reported by any collector. Kept for history.',
    tone: 'neutral',
  },
];

function Posture() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const canMute = can(user, 'posture.mute');
  const canExport = can(user, 'posture.export');
  const canExpect = can(user, 'posture.expected_ports');

  const [summary, setSummary] = useState(null);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [coverageOpen, setCoverageOpen] = useState(false);
  const [installServer, setInstallServer] = useState(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [installScope, setInstallScope] = useState('full');
  const [manualScope, setManualScope] = useState(null);
  const [autoOpen, setAutoOpen] = useState(false);
  const [bulkInstallIds, setBulkInstallIds] = useState(null);

  // Only the queue is open on arrival; the rest are reference and open on
  // demand, each fetching its own page when it does. Their counts come from
  // the summary, so a shut section still says how much is behind it.
  const [openSections, setOpenSections] = useState({ open: true });
  // Bumped after any write, so every OPEN section refetches — muting a
  // finding moves it between two sections, and leaving the other one stale
  // would show the same row in both.
  const [reloadKey, setReloadKey] = useState(0);
  // Seeded from the URL so a link in from Customer Details lands on the
  // filtered view rather than the whole fleet.
  const [searchParams] = useSearchParams();
  const [severity, setSeverity] = useState(searchParams.get('severity') || '');
  const [customerId, setCustomerId] = useState(searchParams.get('customerId') || '');
  const [environment, setEnvironment] = useState('');
  const [customers, setCustomers] = useState([]);

  const [error, setError] = useState('');

  const [selected, setSelected] = useState([]);
  // Selection spans sections, and each section only knows its own rows — so
  // the page remembers the finding objects behind the ids. Bulk actions need
  // the rows, not just the ids, to tell which ones an action can act on.
  const [selectedRows, setSelectedRows] = useState({});
  const handleSelection = useCallback((ids, rows = []) => {
    setSelectedRows((prev) => {
      const next = { ...prev };
      for (const r of rows) next[r.id] = r;
      for (const id of Object.keys(next)) if (!ids.includes(id)) delete next[id];
      return next;
    });
    setSelected(ids);
  }, []);
  const [muteTarget, setMuteTarget] = useState(null); // { ids: [...] } or null
  // Row click opens the finding; the row's … menu keeps the quick actions.
  const [detailFinding, setDetailFinding] = useState(null);
  const [muteSubmitting, setMuteSubmitting] = useState(false);
  const [muteError, setMuteError] = useState('');
  const [busyId, setBusyId] = useState(null);
  const [exportOpen, setExportOpen] = useState(false);
  // Expected-public is per server, so a bulk selection spanning several hosts
  // cannot be declared in one go — the dialog is only offered for a single
  // server's worth of findings.
  const [expectedTarget, setExpectedTarget] = useState(null); // { serverId, targets: [] }
  // The dialog closes on success, so its confirmation lives here instead.
  const [expectedNotice, setExpectedNotice] = useState('');

  const fetchSummary = useCallback(async () => {
    setSummaryLoading(true);
    try {
      // The tiles have to describe the list under them. Without the page's
      // own filters they were fleet totals sitting above a filtered table.
      const data = await getPostureSummary({
        customerId: customerId || undefined,
        environment: environment || undefined,
      });
      setSummary(data);
      // The sidebar badge counts the same thing; broadcasting it here means
      // muting or resolving a finding clears the badge immediately instead of
      // leaving it stale until the next poll.
      window.dispatchEvent(
        new CustomEvent(POSTURE_ALERTS_EVENT, {
          detail: (data?.findings?.critical || 0) + (data?.findings?.high || 0),
        })
      );
    } catch {
      /* the page still works without the summary tiles */
    } finally {
      setSummaryLoading(false);
    }
  }, [customerId, environment]);

  const fetchCustomers = useCallback(async () => {
    try {
      const data = await listCustomers({ page: 1, pageSize: 200 });
      setCustomers(data.items || []);
    } catch {
      /* ignore */
    }
  }, []);

  // One object so every section shares the identity — a new literal each
  // render would refetch all of them on every keystroke.
  const sectionFilters = useMemo(
    () => ({
      severity: severity || undefined,
      customerId: customerId || undefined,
      environment: environment || undefined,
    }),
    [severity, customerId, environment]
  );

  /** Refetch the sections and the counts above them, together. */
  const fetch = useCallback(() => {
    setReloadKey((k) => k + 1);
  }, []);

  useEffect(() => {
    fetchSummary();
    fetchCustomers();
  }, [fetchSummary, fetchCustomers]);

  const resetFilters = () => {
    setSeverity('');
    setCustomerId('');
    setEnvironment('');
  };


  const handleAcknowledge = async (finding) => {
    setBusyId(finding.id);
    try {
      await acknowledgeFinding(finding.id);
      fetch();
    } catch (err) {
      setError(err.response?.data?.error?.message || 'Failed to acknowledge finding');
    } finally {
      setBusyId(null);
    }
  };

  const handleUnmute = async (finding) => {
    setBusyId(finding.id);
    try {
      await unmuteFinding(finding.id);
      fetch();
    } catch (err) {
      setError(err.response?.data?.error?.message || 'Failed to unmute finding');
    } finally {
      setBusyId(null);
    }
  };

  const handleMuteConfirm = async (payload) => {
    if (!muteTarget) return;
    setMuteSubmitting(true);
    setMuteError('');
    try {
      for (const id of muteTarget.ids) {
        // eslint-disable-next-line no-await-in-loop
        await muteFinding(id, payload);
      }
      setMuteTarget(null);
      setSelected([]); setSelectedRows({});
      fetch();
      fetchSummary();
    } catch (err) {
      setMuteError(err.response?.data?.error?.message || 'Failed to mute finding(s)');
    } finally {
      setMuteSubmitting(false);
    }
  };

  // Two groups, because they answer two different questions and mixing them
  // in one row of four was half the confusion: coverage is about hosts,
  // severities are about findings.
  const openTotal = summary
    ? SEVERITIES.reduce((n, key) => n + (summary.findings?.[key] ?? 0), 0)
    : 0;

  // Choosing a severity narrows every section at once and opens the queue,
  // which is where someone clicking "Critical" expects to land.
  const pickSeverity = (key) => {
    setSeverity(key);
    setOpenSections((p) => ({ ...p, open: true }));
  };

  const coverage = summary?.servers;
  const summaryTiles = summary && (
    <div className="space-y-3">
      {/* Every severity, so the tiles add up to the sections below. Showing
          only Critical and High meant a list of four rows sat under tiles
          totalling one, which reads as a bug whichever number you trust. */}
      <PostureTileGrid className="lg:grid-cols-6">
        <PostureTile
          icon={Radar}
          label="All open"
          value={summaryLoading ? '—' : openTotal}
          active={!severity}
          onClick={() => pickSeverity('')}
        />
        {SEVERITY_TILES.map((t) => (
          <PostureTile
            key={t.key}
            icon={t.icon}
            tint={t.tint}
            label={t.label}
            value={summaryLoading ? '—' : summary.findings?.[t.key] ?? 0}
            active={severity === t.key}
            disabled={!summaryLoading && (summary.findings?.[t.key] ?? 0) === 0 && severity !== t.key}
            onClick={() => pickSeverity(severity === t.key ? '' : t.key)}
          />
        ))}
      </PostureTileGrid>

      {/* Coverage is one line, not a second row of cards. It answers a
          question about HOSTS, not findings — and a tile row that mixes the
          two invites reading "0 critical" as good news on a fleet where 31
          of 32 hosts are not reporting at all. Which is exactly the number
          this line exists to keep in front of you. */}
      <button
        type="button"
        onClick={() => setCoverageOpen(true)}
        className="flex w-full flex-wrap items-center gap-x-4 gap-y-1 rounded-md border border-border bg-muted/40 px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:bg-accent/40"
      >
        <span className="flex items-center gap-1.5">
          <Radar className="h-3.5 w-3.5 shrink-0 text-emerald-500" aria-hidden="true" />
          <span className="font-medium text-foreground">{coverage?.reporting ?? 0}</span> of{' '}
          {coverage?.total ?? 0} servers reporting
        </span>
        {/* Reporting, but not the whole picture: a degraded collector's
            "no findings" means less, and a refused one's data is frozen.
            Both are fixed from the coverage list, so both are named here. */}
        {coverage?.degraded > 0 && (
          <span className="flex items-center gap-1.5 text-destructive">
            <ShieldOff className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            {coverage.degraded} degraded
          </span>
        )}
        {coverage?.rejected > 0 && (
          <span className="flex items-center gap-1.5 text-destructive">
            <ServerOff className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            {coverage.rejected} with reports refused
          </span>
        )}
        {coverage?.stale > 0 && (
          <span className="flex items-center gap-1.5 text-amber-600 dark:text-amber-400">
            <ServerOff className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            {coverage.stale} stopped reporting
          </span>
        )}
        {coverage?.notInstalled > 0 && (
          <span className="flex items-center gap-1.5">
            <ServerOff className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="font-medium text-foreground">{coverage.notInstalled}</span> with no
            collector — exposure unknown, not clean
          </span>
        )}
        {/* Counted separately, never as a gap: a Windows or RDP-only host
            cannot run the collector, so folding it into "not installed"
            produced a shortfall no action could ever close. */}
        {coverage?.notApplicable > 0 && (
          <span className="flex items-center gap-1.5 text-muted-foreground/80">
            <span className="font-medium text-foreground">{coverage.notApplicable}</span> cannot run
            the collector
          </span>
        )}
        <span className="ml-auto shrink-0 text-primary">Coverage →</span>
      </button>
    </div>
  );

  const columns = [
    {
      key: 'severity',
      label: 'Severity',
      className: 'w-28',
      mobile: 'hidden', // carried by the card's severity accent + corner tag instead
      render: (r) => <SeverityBadge severity={r.severity} />,
    },
    {
      key: 'finding',
      label: 'Finding',
      searchAccessor: (r) => `${r.message || ''} ${r.code || ''} ${r.ownerLabel || ''}`,
      mobile: [
        { slot: 'title', render: (r) => <span className="break-words">{r.message}</span> },
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
        <div className="max-w-sm">
          <p className="font-medium text-foreground">{r.message}</p>
          <p className="mt-0.5 flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
            <ExpectableMarker finding={r} />
            <span className="min-w-0 truncate">
              {r.code}
              {r.proto && r.port ? ` · ${r.proto}/${r.port}` : ''}
              {r.ownerLabel ? ` · ${r.ownerLabel}` : ''}
            </span>
          </p>
        </div>
      ),
    },
    {
      key: 'server',
      label: 'Server',
      searchAccessor: (r) => serverSearchString(r.server),
      mobile: { slot: 'secondary', render: (r) => (r.server ? `${r.server.displayName || r.server.hostname}` : '—') },
      render: (r) => (
        <button
          onClick={() => navigate(`/servers/${r.server?.id}?tab=findings`)}
          className="flex items-center gap-2 text-left hover:text-primary"
          disabled={!r.server?.id}
        >
          <ServerName server={r.server} />
        </button>
      ),
    },
    {
      key: 'environment',
      label: 'Env',
      mobile: 'hidden',
      render: (r) => <EnvironmentBadge environment={r.server?.environment} />,
    },
    {
      key: 'customer',
      label: 'Customer',
      hideBelow: 'lg',
      mobile: { slot: 'meta', order: 1, render: (r) => r.server?.customer?.name || null },
      render: (r) => <span className="text-muted-foreground">{r.server?.customer?.name || '-'}</span>,
    },
    {
      key: 'lastSeenAt',
      label: 'Last seen',
      hideBelow: 'md',
      mobile: { slot: 'meta', order: 2, render: (r) => relativeTime(r.lastSeenAt) },
      render: (r) => (
        <span className="text-xs text-muted-foreground" title={formatDateTime(r.lastSeenAt)}>
          {relativeTime(r.lastSeenAt)}
        </span>
      ),
    },
    {
      key: 'status',
      label: 'Status',
      mobile: { slot: 'meta', order: 0, render: (r) => <FindingStatusBadge status={r.status} /> },
      render: (r) => (
        <div>
          <FindingStatusBadge status={r.status} />
          {r.status === 'muted' && r.mutedReason && (
            <p className="mt-1 max-w-[14rem] truncate text-[11px] text-muted-foreground" title={r.mutedReason}>
              {r.mutedReason}
            </p>
          )}
        </div>
      ),
    },
    {
      key: 'actions',
      label: '',
      className: 'w-10',
      actions: [
        {
          label: 'View server posture',
          icon: Eye,
          onClick: (r) => navigate(`/servers/${r.server?.id}?tab=findings`),
          hidden: (r) => !r.server?.id,
        },
        {
          label: 'Acknowledge',
          icon: Check,
          onClick: handleAcknowledge,
          hidden: (r) => !canMute || r.status !== 'open' || !!r.acknowledgedAt || busyId === r.id,
        },
        {
          label: 'Mute…',
          icon: VolumeX,
          onClick: (r) => setMuteTarget({ ids: [r.id] }),
          hidden: (r) => !canMute || r.status !== 'open',
        },
        {
          label: 'Unmute',
          icon: Volume1,
          onClick: handleUnmute,
          hidden: (r) => !canMute || r.status !== 'muted' || busyId === r.id,
        },
      ],
    },
  ];

  // Declarative: one "Filters" button and a drawer, with the values as a
  // draft until Apply. These narrow every section at once, so committing
  // three of them used to mean three refetches of whichever was open.
  const filterDefs = [
    {
      key: 'severity',
      label: 'Severity',
      placeholder: 'All severities',
      options: [
        { value: '', label: 'All severities' },
        ...SEVERITIES.map((sv) => ({ value: sv, label: sv[0].toUpperCase() + sv.slice(1) })),
      ],
    },
    {
      key: 'environment',
      label: 'Environment',
      placeholder: 'All environments',
      options: [
        { value: '', label: 'All environments' },
        ...ENVIRONMENTS.map((e) => ({ value: e, label: ENVIRONMENT_LABELS[e] || e })),
      ],
    },
    {
      key: 'customerId',
      label: 'Customer',
      placeholder: 'All customers',
      searchable: true,
      options: [{ value: '', label: 'All customers' }, ...customers.map((c) => ({ value: c.id, label: c.name }))],
    },
  ];

  const filterValues = { severity, environment, customerId };
  const applyFilters = (next) => {
    setSeverity(next.severity ?? '');
    setEnvironment(next.environment ?? '');
    setCustomerId(next.customerId ?? '');
  };


  // Findings currently selected, resolved from the loaded page. Bulk actions
  // only ever act on rows the user can actually see.
  const selectedFindings = selected.map((id) => selectedRows[id]).filter(Boolean);
  const selectionServerIds = [...new Set(selectedFindings.map((f) => f.server?.id).filter(Boolean))];
  const selectionIsOneServer = selectionServerIds.length === 1;

  // Only exposure findings can be resolved by declaring a port expected; a
  // firewall or already-expected finding would come back unchanged, which is
  // indistinguishable from the action having done nothing.
  const expectableFindings = selectedFindings.filter(canMarkExpected);

  const openBulkExpected = () => {
    if (!selectionIsOneServer || expectableFindings.length === 0) return;
    setExpectedTarget({
      serverId: selectionServerIds[0],
      targets: expectableFindings.map((f) => ({ port: f.port, proto: f.proto })),
      skipped: selectedFindings.length - expectableFindings.length,
    });
  };

  const handleBulkAcknowledge = async () => {
    setBusyId('bulk');
    try {
      // Sequential, not Promise.all: each one is an audited write, and a
      // burst of them against a shared API is a worse trade than a second of
      // latency on a bulk action.
      for (const id of selected) {
        await acknowledgeFinding(id);
      }
      setSelected([]); setSelectedRows({});
      fetch();
      fetchSummary();
    } catch (err) {
      setError(err.response?.data?.error?.message || 'Failed to acknowledge findings');
    } finally {
      setBusyId(null);
    }
  };

  const bulkActionsSlot =
    selected.length > 0 ? (
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
              onClick={openBulkExpected}
              disabled={!selectionIsOneServer || expectableFindings.length === 0}
              title={
                !selectionIsOneServer
                  ? 'Expected-public is per server — select findings from one server'
                  : expectableFindings.length === 0
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
    ) : null;

  // Three distinct empty states (spec §9.14): posture not enabled at all
  // (never seen a snapshot), enabled but genuinely clean, and — the state
  // that must never be confused with "clean" — a filtered view with nothing
  // matching.
  const noneEverReported = !summaryLoading && summary && (summary.servers?.total ?? 0) === 0;
  const hasActiveFilter = !!(severity || customerId || environment);
  const emptyState = noneEverReported ? (
    <EmptyState
      icon={Radar}
      title="Posture isn't collecting yet"
      description="No server has reported a posture snapshot. Bootstrap or re-provision a host to install the collector — it starts reporting within a few minutes."
      action={{ label: 'Go to servers', onClick: () => navigate('/servers') }}
    />
  ) : !hasActiveFilter ? (
    <EmptyState icon={ShieldCheck} title="No open findings" description="Every reporting server is clean right now." />
  ) : (
    <EmptyState
      icon={ShieldAlert}
      title="Nothing matches these filters"
      description="Try a different severity, customer, environment or status."
      action={{ label: 'Reset filters', onClick: resetFilters }}
    />
  );

  return (
    <div className="space-y-5 p-6 max-md:p-4 sm:space-y-6">
      <PageHeader
        icon={Radar}
        title="Posture"
        subtitle="Exposure findings across every server that reports to Shellius."
        helpKey="posture"
        actions={[
          { key: 'export', label: 'Export', icon: Download, variant: 'outline', onClick: () => setExportOpen(true), hidden: !canExport },
          { key: 'refresh', label: 'Refresh', icon: RefreshCw, variant: 'outline', onClick: () => { fetch(); fetchSummary(); } },
        ]}
      />

      {summaryTiles}

      {/* docs/posture/posture-spec.md §9.4: say what this view does NOT cover.
          Findings describe the host's own listeners and firewall. A cloud
          security group in front of the host can close a port this page calls
          exposed, or open one it calls closed — so a clean page here is not
          the same as "not reachable". The SG join is Phase 2 and is not
          built; silently implying full coverage would be the worse bug. */}
      <div className="flex items-start gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        {/* The caveat matters, but at phone width the full paragraph was six
            lines above the findings. The first sentence carries the warning;
            the rest is the explanation, kept for anyone with the room. */}
        <p>
          <span className="font-medium text-foreground">Host-only view.</span> These findings come
          from each host&rsquo;s own listeners and firewall.{' '}
          <span className="max-sm:hidden">
            Cloud security groups and external firewalls are not read yet, so a port shown here as
            exposed may still be blocked upstream — and one shown as closed may be reachable through
            a rule Shellius cannot see.
          </span>
        </p>
      </div>

      {expectedNotice && (
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

      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {noneEverReported ? (
        emptyState
      ) : (
        <>
          {/* Filters live above the sections, not inside one, because they
              apply to all of them — a severity filter that only narrowed
              "Open" would make the other counts lie. */}
          <div className="flex flex-wrap items-center gap-2">
            <FilterControl defs={filterDefs} values={filterValues} onChange={applyFilters} />
          </div>

          <div className="space-y-2">
            {FINDING_SECTIONS.map((sec) => (
              <FleetFindingsSection
                key={sec.key}
                section={sec.key}
                title={sec.title}
                description={sec.description}
                tone={sec.tone}
                count={summary?.sections?.[sec.key] ?? 0}
                filters={sectionFilters}
                columns={columns}
                open={!!openSections[sec.key]}
                onToggle={() => setOpenSections((p) => ({ ...p, [sec.key]: !p[sec.key] }))}
                onRowClick={setDetailFinding}
                // Bulk actions only where they mean something: you cannot
                // mute what is already muted or resolved.
                selectable={canMute && (sec.key === 'open' || sec.key === 'acknowledged')}
                selectedIds={selected}
                onSelectionChange={handleSelection}
                bulkActions={bulkActionsSlot}
                reloadKey={reloadKey}
                mobile={{
                  accent: (r) => severityAccent(r.severity),
                  // Finding messages are sentences; one truncated line left
                  // every card starting the same way and saying nothing.
                  titleClamp: 2,
                  group: (r) =>
                    r.server
                      ? { key: r.server.id, label: r.server.displayName || r.server.hostname }
                      : { key: 'unknown', label: 'Unknown server' },
                }}
              />
            ))}
          </div>

          {canExpect && (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-emerald-600/70 dark:text-emerald-400/70" aria-hidden="true" />
              marks a finding that <span className="font-medium text-foreground">Mark expected</span> can
              resolve. Mute and Acknowledge apply to every finding.
            </p>
          )}
        </>
      )}

      <CollectorCoverageModal
        open={coverageOpen}
        canInstall={can(user, 'servers.onboard')}
        onClose={() => setCoverageOpen(false)}
        onInstallAll={(ids) => {
          setCoverageOpen(false);
          setBulkInstallIds(ids);
        }}
        onInstall={(server) => {
          // Hand straight to the same wizard the server page uses, so the
          // choices (and their warnings) are identical wherever you start.
          setCoverageOpen(false);
          setInstallServer(server);
          setWizardOpen(true);
        }}
      />

      <BulkInstallModal
        open={!!bulkInstallIds}
        serverIds={bulkInstallIds || []}
        onClose={() => setBulkInstallIds(null)}
        onDone={fetchSummary}
      />

      <BootstrapWizard
        open={wizardOpen}
        server={installServer}
        onClose={() => {
          setWizardOpen(false);
          setInstallServer(null);
        }}
        onStart={({ method, scope }) => {
          // Close the wizard but KEEP installServer — the follow-up modal needs it.
          setWizardOpen(false);
          setInstallScope(scope);
          if (method === 'manual') setManualScope(scope);
          else setAutoOpen(true);
        }}
      />

      <BootstrapModal
        open={!!manualScope}
        mode={manualScope || 'full'}
        server={installServer}
        onClose={() => {
          setManualScope(null);
          setInstallServer(null);
        }}
      />

      {autoOpen && installServer && (
        <ProvisionModal
          server={installServer}
          installMode={installScope}
          onClose={() => {
            setAutoOpen(false);
            setInstallServer(null);
            fetchSummary();
          }}
        />
      )}

      <FindingDetailModal
        open={!!detailFinding}
        finding={detailFinding}
        onClose={() => setDetailFinding(null)}
        canMute={canMute}
        busy={busyId === detailFinding?.id}
        onAcknowledge={(f) => { setDetailFinding(null); handleAcknowledge(f); }}
        onMute={(f) => { setDetailFinding(null); setMuteTarget({ ids: [f.id] }); }}
        onUnmute={(f) => { setDetailFinding(null); handleUnmute(f); }}
      />

      <ExportDialog
        open={exportOpen}
        dataset="findings"
        filters={{ status: 'open', severity: severity || undefined, environment: environment || undefined, customerId: customerId || undefined }}
        serverCount={2}
        scopeLabel="findings matching the current filters"
        onClose={() => setExportOpen(false)}
      />

      <ExpectedPortDialog
        open={!!expectedTarget}
        serverId={expectedTarget?.serverId}
        targets={expectedTarget?.targets || []}
        skipped={expectedTarget?.skipped || 0}
        onClose={() => setExpectedTarget(null)}
        onDone={(result) => {
          setExpectedTarget(null);
          setSelected([]); setSelectedRows({});
          setExpectedNotice(
            `${result.added} port${result.added === 1 ? '' : 's'} marked as expected` +
              (result.skipped ? `, ${result.skipped} already were` : '') +
              `. ${result.resolvedFindings} finding${result.resolvedFindings === 1 ? '' : 's'} resolved.`
          );
          fetch();
          fetchSummary();
        }}
      />

      <MuteDialog
        open={!!muteTarget}
        count={muteTarget?.ids?.length || 1}
        submitting={muteSubmitting}
        error={muteError}
        onConfirm={handleMuteConfirm}
        onCancel={() => { setMuteTarget(null); setMuteError(''); }}
      />
    </div>
  );
}

export default Posture;
