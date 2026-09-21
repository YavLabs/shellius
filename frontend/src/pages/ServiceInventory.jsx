import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Boxes,
  Download,
  Globe,
  Info,
  Network,
  RefreshCw,
  Server as ServerIcon,
  ShieldAlert,
} from 'lucide-react';
import PageHeader from '@/components/common/PageHeader';
import DataTable from '@/components/shared/DataTable';
import EmptyState from '@/components/ui/EmptyState';
import MetricCard from '@/components/dashboard/MetricCard';
import EnvironmentBadge from '@/components/shared/EnvironmentBadge';
import ServerName, { serverSearchString } from '@/components/shared/ServerName';
import SeverityBadge from '@/components/posture/SeverityBadge';
import ExportDialog from '@/components/posture/ExportDialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { reachabilityTone } from '@/lib/badgeTones';
import { serviceLabel } from '@/lib/postureLabels';
import { can } from '@/lib/permissions';
import { useAuth } from '@/context/AuthContext';
import { fromState } from '@/hooks/useBackTarget';
import { useBreadcrumbs } from '@/context/BreadcrumbContext';
import {
  getInventoryFacets,
  listInventoryListeners,
  listInventoryServices,
} from '@/services/postureService';
import { listCustomers } from '@/services/customerService';
import { ENVIRONMENT_LABELS } from '@/lib/labels';

/**
 * Services & ports — what is running across the fleet.
 *
 * Posture answers "what is wrong here". This answers "what is running, and
 * where", which is a different question with its own users: find every host
 * running a service before a CVE window closes, prove that nothing still
 * listens on a port you retired, hand an auditor the list. Until now the
 * only way to ask it was to open each server's Ports tab one at a time,
 * which means in practice nobody asked it.
 *
 * Two views over the same rows. **Services** groups by what is listening —
 * the container name, the unit, the detected protocol — because "where is
 * nginx deployed" is a question about a service, not a port. **Ports** is
 * the flat list, for when the question really is about a number.
 *
 * Both read from each host's latest snapshot only. A port that closed last
 * week is not in this inventory, and a host that stopped reporting is
 * showing you its last known state — which is why the coverage line at the
 * top says how many hosts are behind these numbers.
 */

const ENVIRONMENTS = ['demo', 'dev', 'staging', 'prod'];

const KIND_LABELS = {
  service: 'Protocol',
  docker: 'Docker',
  'docker-proxy': 'Docker',
  podman: 'Podman',
  pm2: 'PM2',
  systemd: 'systemd',
  process: 'Process',
  unknown: 'Unattributed',
};

function ServiceInventory() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const canExport = can(user, 'posture.export');
  const [params, setParams] = useSearchParams();

  const serviceKey = params.get('service') || '';
  const q = params.get('q') || '';
  const proto = params.get('proto') || '';
  const reachability = params.get('reachability') || '';
  const ownerKind = params.get('ownerKind') || '';
  const environment = params.get('environment') || '';
  const customerId = params.get('customerId') || '';
  const port = params.get('port') || '';
  const state = params.get('state') || '';

  const [services, setServices] = useState(null);
  const [listeners, setListeners] = useState(null);
  const [facets, setFacets] = useState(null);
  const [customers, setCustomers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [exportOpen, setExportOpen] = useState(false);

  useBreadcrumbs([{ label: 'Services & ports' }]);

  const patch = useCallback(
    (next) => {
      const merged = new URLSearchParams(params);
      for (const [k, v] of Object.entries(next)) {
        if (v === null || v === '' || v === undefined) merged.delete(k);
        else merged.set(k, v);
      }
      setParams(merged, { replace: true });
      setPage(1);
    },
    [params, setParams]
  );

  // Shared by both views and by the export, so the file can never describe a
  // different set of rows than the screen.
  const filters = useMemo(
    () => ({
      q: q || undefined,
      proto: proto || undefined,
      reachability: reachability || undefined,
      ownerKind: ownerKind || undefined,
      environment: environment || undefined,
      customerId: customerId || undefined,
      port: port || undefined,
      serviceKey: serviceKey || undefined,
      state: state || undefined,
    }),
    [q, proto, reachability, ownerKind, environment, customerId, port, serviceKey, state]
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      // The grouped call feeds the tiles only. One grid was showing the same
      // rows twice under two tab names — but "how many distinct services"
      // still has to come from the grouping, not from a page of ports.
      const [rows, grouped] = await Promise.all([
        listInventoryListeners({ ...filters, page, limit: pageSize }),
        listInventoryServices(filters),
      ]);
      setListeners(rows);
      setServices(grouped);
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message || 'Could not load the inventory');
    } finally {
      setLoading(false);
    }
  }, [filters, page, pageSize]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    getInventoryFacets().then(setFacets).catch(() => setFacets(null));
    listCustomers({ page: 1, pageSize: 200 })
      .then((d) => setCustomers(d.items || []))
      .catch(() => setCustomers([]));
  }, []);

  // The services view always loads the whole grouped set, so its totals are
  // the honest fleet numbers rather than a page's worth.
  const summary = services?.meta;

  const resetFilters = () =>
    patch({
      q: null,
      proto: null,
      reachability: null,
      ownerKind: null,
      environment: null,
      customerId: null,
      port: null,
      service: null,
      state: null,
    });

  const activeFilterCount = [proto, reachability, ownerKind, environment, customerId, port, serviceKey, state].filter(
    Boolean
  ).length;

  // Declarative: DataTable renders these behind one "Filters" button, in a
  // drawer, as a draft until Apply. Six selects in a row above the table
  // wrapped onto two lines on a laptop and fired a request per change.
  const filterDefs = [
    {
      key: 'proto',
      label: 'Protocol',
      placeholder: 'All protocols',
      options: [
        { value: '', label: 'All protocols' },
        ...(facets?.protos || []).map((p) => ({ value: p.value, label: `${p.value.toUpperCase()} (${p.count})` })),
      ],
    },
    {
      key: 'reachability',
      label: 'Reachability',
      placeholder: 'All reachability',
      options: [
        { value: '', label: 'All reachability' },
        ...(facets?.reachability || []).map((r) => ({
          value: r.value,
          label: `${reachabilityTone(r.value).label} (${r.count})`,
        })),
        // Not a facet: facets are computed from host sockets, and this value
        // only ever lives on a container's own declaration.
        { value: 'CONTAINER', label: 'Container-internal' },
      ],
    },
    {
      key: 'ownerKind',
      label: 'Runtime',
      placeholder: 'All runtimes',
      options: [
        { value: '', label: 'All runtimes' },
        ...(facets?.ownerKinds || []).map((k) => ({
          value: k.value,
          label: `${KIND_LABELS[k.value] || k.value} (${k.count})`,
        })),
      ],
    },
    {
      key: 'state',
      label: 'State',
      placeholder: 'Any state',
      options: [
        { value: '', label: 'Any state' },
        { value: 'exposed', label: 'Listening on the host' },
        { value: 'internal', label: 'Container-internal only' },
        { value: 'running', label: 'Running (either)' },
        { value: 'stopped', label: 'Installed, stopped' },
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

  const filterValues = { proto, reachability, ownerKind, state, environment, customerId };

  const filtered = !!(activeFilterCount || q);
  const emptyState = (
    <EmptyState
      icon={Network}
      title={filtered ? 'Nothing matches these filters' : 'No services reported yet'}
      description={
        filtered
          ? 'Try a different runtime, protocol, environment or customer.'
          : 'Services appear here once hosts run the posture collector. Install it from Servers → Install collectors.'
      }
      action={
        filtered
          ? { label: 'Reset filters', onClick: resetFilters }
          : { label: 'Go to servers', onClick: () => navigate('/servers') }
      }
    />
  );

  const exportButton = canExport ? (
    <Button variant="outline" size="sm" onClick={() => setExportOpen(true)}>
      <Download className="mr-1.5 h-4 w-4" /> Export
    </Button>
  ) : null;

  const listenerColumns = [
    {
      key: 'port',
      label: 'Port',
      className: 'w-28',
      sortAccessor: (r) => r.port,
      mobile: { slot: 'title', render: (r) => `${(r.proto || '').toUpperCase()}/${r.port}` },
      render: (r) => (
        <span className="font-mono text-sm">
          {(r.proto || '').toUpperCase()}/{r.port}
        </span>
      ),
    },
    {
      key: 'service',
      label: 'Service',
      searchAccessor: (r) => serviceLabel(r).text,
      mobile: { slot: 'secondary', render: (r) => serviceLabel(r).text },
      render: (r) => {
        const { text, inferred } = serviceLabel(r);
        return (
          <span className={inferred ? 'text-muted-foreground' : 'text-foreground'} title={text}>
            {text}
          </span>
        );
      },
    },
    {
      key: 'state',
      label: 'State',
      className: 'w-32',
      sortAccessor: (r) =>
        r.listening === false ? 'stopped' : r.containerInternal ? 'internal' : 'running',
      searchAccessor: (r) =>
        r.listening === false
          ? `stopped ${r.serviceState || ''}`
          : r.containerInternal
            ? 'internal container running'
            : 'running listening exposed',
      // A port that is closed only because the service behind it is stopped
      // is a different thing from a port nobody serves — and the whole
      // reason the collector now looks past open sockets.
      mobile: {
        slot: 'meta',
        order: 4,
        render: (r) =>
          r.listening === false ? (
            <Badge tone="warning" title={r.serviceStatusText || undefined}>
              {r.serviceState || 'stopped'}
            </Badge>
          ) : null,
      },
      render: (r) => {
        if (r.listening === false) {
          return (
            <Badge tone="warning" title={r.serviceStatusText || 'Installed but not running'}>
              {r.serviceState || 'stopped'}
            </Badge>
          );
        }
        if (r.containerInternal) {
          return (
            <Badge tone="neutral" title="Listening inside the container only — not bound on the host">
              internal
            </Badge>
          );
        }
        return <span className="text-xs text-muted-foreground">Listening</span>;
      },
    },
    {
      key: 'server',
      label: 'Server',
      searchAccessor: (r) => serverSearchString(r.server),
      mobile: { slot: 'meta', order: 3, render: (r) => r.server?.hostname },
      render: (r) => <ServerName server={r.server} />,
    },
    {
      key: 'customer',
      label: 'Customer',
      hideBelow: 'lg',
      searchAccessor: (r) => r.server?.customer?.name || '',
      mobile: 'hidden',
      render: (r) => <span className="text-muted-foreground">{r.server?.customer?.name || '-'}</span>,
    },
    {
      key: 'environment',
      label: 'Env',
      className: 'w-24',
      sortAccessor: (r) => r.server?.environment || '',
      mobile: { slot: 'meta', order: 2, render: (r) => <EnvironmentBadge environment={r.server?.environment} /> },
      render: (r) => <EnvironmentBadge environment={r.server?.environment} />,
    },
    {
      key: 'reachability',
      label: 'Reachability',
      mobile: {
        slot: 'meta',
        order: 1,
        render: (r) =>
          r.listening === false && !r.reachability ? null : (
            <Badge tone={reachabilityTone(r.reachability).tone}>{reachabilityTone(r.reachability).label}</Badge>
          ),
      },
      render: (r) => {
        if (r.listening === false && !r.reachability) {
          return <span className="text-xs text-muted-foreground">—</span>;
        }
        const { tone, label } = reachabilityTone(r.reachability);
        return <Badge tone={tone}>{label}</Badge>;
      },
    },
    {
      key: 'findings',
      label: 'Findings',
      className: 'w-28',
      sortAccessor: (r) => (r.findings || []).length,
      mobile: {
        slot: 'meta',
        order: 0,
        render: (r) =>
          (r.findings || []).length === 0 ? null : (
            <span className="flex gap-1">
              {r.findings.map((f) => (
                <SeverityBadge key={f.id} severity={f.severity} />
              ))}
            </span>
          ),
      },
      render: (r) =>
        (r.findings || []).length === 0 ? (
          <span className="text-xs text-muted-foreground">—</span>
        ) : (
          <div className="flex flex-wrap gap-1">
            {r.findings.map((f) => (
              <SeverityBadge key={f.id} severity={f.severity} />
            ))}
          </div>
        ),
    },
  ];

  // Carries where you came from, so Server Details offers "Back to Services
  // & ports" rather than dropping you on the servers list.
  const openServer = (serverId) =>
    navigate(`/servers/${serverId}?tab=ports`, { state: fromState('/services', 'Services & ports') });

  return (
    <div className="space-y-5 p-6 max-md:p-4 sm:space-y-6">
      <PageHeader
        icon={Network}
        title="Services & ports"
        subtitle="Every service listening across the fleet, and where it runs."
        actions={[
          {
            key: 'refresh',
            label: 'Refresh',
            icon: RefreshCw,
            variant: 'outline',
            onClick: load,
            disabled: loading,
            spin: loading,
          },
          {
            key: 'export',
            label: 'Export',
            icon: Download,
            variant: 'outline',
            hidden: !canExport,
            onClick: () => setExportOpen(true),
          },
        ]}
      />

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 sm:gap-3">
        <MetricCard
          title="Services"
          value={summary ? summary.total : '—'}
          subtitle="Distinct, in scope"
          icon={Boxes}
          accent="primary"
          loading={loading && !services}
        />
        <MetricCard
          title="Listening ports"
          value={summary ? summary.listeners : '—'}
          subtitle="Across every host"
          icon={Network}
          accent="violet"
          loading={loading && !services}
        />
        <MetricCard
          title="Hosts reporting"
          value={summary ? summary.servers : '—'}
          subtitle="Behind these numbers"
          icon={ServerIcon}
          accent="emerald"
          loading={loading && !services}
        />
        <MetricCard
          title="Internet-facing"
          value={services ? services.items.reduce((n, s) => n + s.internetExposed, 0) : '—'}
          subtitle="Bound to any address"
          icon={Globe}
          accent="rose"
          loading={loading && !services}
          onClick={() => patch({ reachability: 'INTERNET' })}
        />
      </div>

      {/* Same caveat as the Posture page, and for the same reason: this is the
          host's own view of itself. A cloud security group in front of it can
          close a port shown here as internet-facing. */}
      <div className="flex items-start gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <p>
          <span className="font-medium text-foreground">Latest snapshot per host.</span> Only hosts
          running the collector appear here.{' '}
          <span className="max-sm:hidden">
            &ldquo;Internet-facing&rdquo; means the process is bound to a wildcard address with no
            host firewall rule in the way — a cloud security group upstream may still be blocking it.
          </span>
        </p>
      </div>

      {serviceKey && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-primary/40 bg-primary/5 px-3 py-2 text-sm">
          <span className="text-foreground">
            Filtered to <span className="font-medium">{serviceKey.split(':').slice(1).join(':')}</span>
          </span>
          <button type="button" onClick={() => patch({ service: null })} className="text-xs text-primary hover:underline">
            Show everything
          </button>
        </div>
      )}

      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* An empty result REPLACES the table rather than rendering inside it.
          DataTable puts its empty state in a tbody cell, which is already
          inside the table's own bordered card — so an EmptyState card there
          is a card in a card, under a header row of columns with nothing
          under them. Same split as MyHosts / Roles / Posture. */}
      {!loading && (listeners?.items || []).length === 0 ? (
        emptyState
      ) : (
      <DataTable
        columns={listenerColumns}
        data={listeners?.items || []}
        loading={loading}
        filterDefs={filterDefs}
        filterValues={filterValues}
        onFilterChange={(next) => patch(next)}
        toolbarActions={exportButton}
        searchPlaceholder="Search service, port, host, owner or customer..."
        onSearchChange={(value) => patch({ q: value })}
        onRowClick={(r) => r.server?.id && openServer(r.server.id)}
        serverPagination={{
          page,
          total: listeners?.meta?.total ?? 0,
          onPageChange: setPage,
          pageSize,
          onPageSizeChange: (size) => {
            setPageSize(size);
            setPage(1);
          },
        }}
        mobile={{
          accent: (r) =>
            r.listening === false
              ? { tone: 'warning' }
              : r.reachability === 'INTERNET'
                ? { tone: 'danger' }
                : null,
        }}
      />
      )}

      <ExportDialog
        open={exportOpen}
        dataset="listeners"
        filters={filters}
        serverCount={summary?.servers ?? 1}
        scopeLabel="the listening ports matching these filters"
        onClose={() => setExportOpen(false)}
      />
    </div>
  );
}

export default ServiceInventory;
