import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Radar,
  ShieldAlert,
  ShieldCheck,
  ServerOff,
  VolumeX,
  Volume1,
  Check,
  Eye,
  RefreshCw,
  Info,
  Download,
} from 'lucide-react';
import DataTable from '@/components/shared/DataTable';
import PageHeader from '@/components/common/PageHeader';
import EmptyState from '@/components/ui/EmptyState';
import MetricCard from '@/components/dashboard/MetricCard';
import ServerName, { serverSearchString } from '@/components/shared/ServerName';
import EnvironmentBadge from '@/components/shared/EnvironmentBadge';
import SeverityBadge from '@/components/posture/SeverityBadge';
import FindingStatusBadge from '@/components/posture/FindingStatusBadge';
import MuteDialog from '@/components/posture/MuteDialog';
import CollectorCoverageModal from '@/components/posture/CollectorCoverageModal';
import FindingDetailModal from '@/components/posture/FindingDetailModal';
import ExportDialog from '@/components/posture/ExportDialog';
import ExpectedPortDialog from '@/components/posture/ExpectedPortDialog';
import { canMarkExpected } from '@/lib/postureLabels';
import BootstrapWizard from '@/components/servers/BootstrapWizard';
import BootstrapModal from '@/components/servers/BootstrapModal';
import ProvisionModal from '@/components/servers/ProvisionModal';
import { Button } from '@/components/ui/button';
import SearchableSelect from '@/components/ui/SearchableSelect';
import {
  getPostureSummary,
  listFindings,
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
const ENVIRONMENTS = ['demo', 'dev', 'staging', 'prod'];
const STATUS_TABS = [
  { key: 'open', label: 'Open' },
  { key: 'muted', label: 'Muted' },
  { key: 'resolved', label: 'Resolved' },
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

  const [status, setStatus] = useState('open');
  // Seeded from the URL so a link in from Customer Details lands on the
  // filtered view rather than the whole fleet.
  const [searchParams] = useSearchParams();
  const [severity, setSeverity] = useState(searchParams.get('severity') || '');
  const [customerId, setCustomerId] = useState(searchParams.get('customerId') || '');
  const [environment, setEnvironment] = useState('');
  const [customers, setCustomers] = useState([]);

  const [findings, setFindings] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [selected, setSelected] = useState([]);
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
      const data = await getPostureSummary();
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
  }, []);

  const fetchCustomers = useCallback(async () => {
    try {
      const data = await listCustomers({ page: 1, pageSize: 200 });
      setCustomers(data.items || []);
    } catch {
      /* ignore */
    }
  }, []);

  const fetch = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = { page, limit: pageSize, status };
      if (severity) params.severity = severity;
      if (customerId) params.customerId = customerId;
      if (environment) params.environment = environment;
      const data = await listFindings(params);
      setFindings(data.findings || []);
      setTotal(data.meta?.total ?? data.findings?.length ?? 0);
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message || 'Failed to load findings');
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, status, severity, customerId, environment]);

  useEffect(() => {
    fetchSummary();
    fetchCustomers();
  }, [fetchSummary, fetchCustomers]);

  useEffect(() => {
    fetch();
  }, [fetch]);

  const resetFilters = () => {
    setSeverity('');
    setCustomerId('');
    setEnvironment('');
    setPage(1);
  };

  const changeStatus = (key) => {
    setStatus(key);
    setSelected([]);
    setPage(1);
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
      setSelected([]);
      fetch();
      fetchSummary();
    } catch (err) {
      setMuteError(err.response?.data?.error?.message || 'Failed to mute finding(s)');
    } finally {
      setMuteSubmitting(false);
    }
  };

  const summaryTiles = summary && (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 sm:gap-3">
      <MetricCard
        title="Reporting"
        value={summaryLoading ? '—' : summary.servers?.reporting ?? 0}
        subtitle={`of ${summary.servers?.total ?? 0} servers`}
        icon={Radar}
        accent="emerald"
        loading={summaryLoading}
        onClick={() => setCoverageOpen(true)}
      />
      <MetricCard
        title="Stale"
        value={summaryLoading ? '—' : summary.servers?.stale ?? 0}
        subtitle="stopped reporting"
        icon={ServerOff}
        accent="amber"
        loading={summaryLoading}
        onClick={summary.servers?.stale ? () => navigate('/servers') : undefined}
      />
      <MetricCard
        title="Critical"
        value={summaryLoading ? '—' : summary.findings?.critical ?? 0}
        subtitle="open findings"
        icon={ShieldAlert}
        accent="rose"
        loading={summaryLoading}
        onClick={() => {
          setStatus('open');
          setSeverity('critical');
          setPage(1);
        }}
      />
      <MetricCard
        title="High"
        value={summaryLoading ? '—' : summary.findings?.high ?? 0}
        subtitle="open findings"
        icon={ShieldAlert}
        accent="violet"
        loading={summaryLoading}
        onClick={() => {
          setStatus('open');
          setSeverity('high');
          setPage(1);
        }}
      />
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
      mobile: {
        slot: 'title',
        render: (r) => <span className="break-words">{r.message}</span>,
      },
      render: (r) => (
        <div className="max-w-sm">
          <p className="font-medium text-foreground">{r.message}</p>
          <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">
            {r.code}
            {r.proto && r.port ? ` · ${r.proto}/${r.port}` : ''}
            {r.ownerLabel ? ` · ${r.ownerLabel}` : ''}
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

  const filterSlot = (
    <>
      <SearchableSelect
        className="w-[150px]"
        value={severity}
        onChange={(v) => { setSeverity(v); setPage(1); }}
        options={[{ value: '', label: 'All severities' }, ...SEVERITIES.map((s) => ({ value: s, label: s[0].toUpperCase() + s.slice(1) }))]}
        placeholder="All severities"
        searchable={false}
        clearable={false}
      />
      <SearchableSelect
        className="w-[150px]"
        value={environment}
        onChange={(v) => { setEnvironment(v); setPage(1); }}
        options={[{ value: '', label: 'All environments' }, ...ENVIRONMENTS.map((e) => ({ value: e, label: ENVIRONMENT_LABELS[e] || e }))]}
        placeholder="All environments"
        searchable={false}
        clearable={false}
      />
      <SearchableSelect
        className="w-[180px]"
        value={customerId}
        onChange={(v) => { setCustomerId(v); setPage(1); }}
        options={[{ value: '', label: 'All customers' }, ...customers.map((c) => ({ value: c.id, label: c.name }))]}
        placeholder="All customers"
        searchable
        clearable={false}
      />
    </>
  );

  // Findings currently selected, resolved from the loaded page. Bulk actions
  // only ever act on rows the user can actually see.
  const selectedFindings = findings.filter((f) => selected.includes(f.id));
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
      setSelected([]);
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
  const hasActiveFilter = !!(severity || customerId || environment) || status !== 'open';
  const emptyState = noneEverReported ? (
    <EmptyState
      icon={Radar}
      title="Posture isn't collecting yet"
      description="No server has reported a posture snapshot. Bootstrap or re-provision a host to install the collector — it starts reporting within a few minutes."
      action={{ label: 'Go to servers', onClick: () => navigate('/servers') }}
    />
  ) : status === 'open' && !hasActiveFilter ? (
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
          { key: 'refresh', label: 'Refresh', icon: RefreshCw, variant: 'outline', onClick: () => { fetch(); fetchSummary(); }, disabled: loading, spin: loading },
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

      <div className="flex items-center gap-1 overflow-x-auto border-b border-border">
        {STATUS_TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => changeStatus(tab.key)}
            className={[
              'relative shrink-0 whitespace-nowrap px-2.5 py-2.5 text-sm font-medium transition-colors md:px-4',
              status === tab.key ? 'border-b-2 border-primary text-foreground' : 'text-muted-foreground hover:text-foreground',
            ].join(' ')}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* An empty result (no findings at all, or none matching the current
          filters) is fully replaced by its EmptyState card — never rendered
          alongside the table's header row / bulk-select checkbox (see
          pages/MyHosts.jsx, pages/Roles.jsx for the same list-vs-EmptyState
          split). Loading keeps the table mounted so its skeleton rows show. */}
      {!loading && findings.length === 0 ? (
        emptyState
      ) : (
        <DataTable
          columns={columns}
          data={findings}
          onRowClick={setDetailFinding}
          loading={loading}
          emptyState={emptyState}
          showSearch={false}
          filters={filterSlot}
          onResetFilters={resetFilters}
          selectable={canMute && status === 'open'}
          selectedIds={selected}
          onSelectionChange={setSelected}
          bulkActions={bulkActionsSlot}
          mobile={{
            accent: (r) => severityAccent(r.severity),
            // Finding messages are sentences; one truncated line left every
            // card starting the same way and saying nothing.
            titleClamp: 2,
            group: (r) =>
              r.server
                ? { key: r.server.id, label: r.server.displayName || r.server.hostname }
                : { key: 'unknown', label: 'Unknown server' },
          }}
          serverPagination={{
            page,
            total,
            onPageChange: setPage,
            pageSize,
            onPageSizeChange: (size) => { setPageSize(size); setPage(1); },
          }}
        />
      )}

      <CollectorCoverageModal
        open={coverageOpen}
        canInstall={can(user, 'servers.onboard')}
        onClose={() => setCoverageOpen(false)}
        onInstall={(server) => {
          // Hand straight to the same wizard the server page uses, so the
          // choices (and their warnings) are identical wherever you start.
          setCoverageOpen(false);
          setInstallServer(server);
          setWizardOpen(true);
        }}
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
        filters={{ status, severity: severity || undefined, environment: environment || undefined, customerId: customerId || undefined }}
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
          setSelected([]);
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
