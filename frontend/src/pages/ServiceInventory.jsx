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
import SearchableSelect from '@/components/ui/SearchableSelect';
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

const TABS = [
  { key: 'services', label: 'Services' },
  { key: 'ports', label: 'Ports' },
];

function ServiceInventory() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const canExport = can(user, 'posture.export');
  const [params, setParams] = useSearchParams();

  const tab = params.get('tab') === 'ports' ? 'ports' : 'services';
  const serviceKey = params.get('service') || '';
  const q = params.get('q') || '';
  const proto = params.get('proto') || '';
  const reachability = params.get('reachability') || '';
  const ownerKind = params.get('ownerKind') || '';
  const environment = params.get('environment') || '';
  const customerId = params.get('customerId') || '';
  const port = params.get('port') || '';

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
    }),
    [q, proto, reachability, ownerKind, environment, customerId, port, serviceKey]
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      if (tab === 'services') {
        setServices(await listInventoryServices(filters));
      } else {
        setListeners(await listInventoryListeners({ ...filters, page, limit: pageSize }));
      }
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message || 'Could not load the inventory');
    } finally {
      setLoading(false);
    }
  }, [tab, filters, page, pageSize]);

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
    });

  const activeFilterCount = [proto, reachability, ownerKind, environment, customerId, port, serviceKey].filter(
    Boolean
  ).length;

  const filterSlot = (
    <>
      <SearchableSelect
        className="w-[130px]"
        value={proto}
        onChange={(v) => patch({ proto: v })}
        options={[
          { value: '', label: 'All protocols' },
          ...(facets?.protos || []).map((p) => ({ value: p.value, label: `${p.value.toUpperCase()} (${p.count})` })),
        ]}
        placeholder="All protocols"
        searchable={false}
        clearable={false}
      />
      <SearchableSelect
        className="w-[170px]"
        value={reachability}
        onChange={(v) => patch({ reachability: v })}
        options={[
          { value: '', label: 'All reachability' },
          ...(facets?.reachability || []).map((r) => ({
            value: r.value,
            label: `${reachabilityTone(r.value).label} (${r.count})`,
          })),
        ]}
        placeholder="All reachability"
        searchable={false}
        clearable={false}
      />
      <SearchableSelect
        className="w-[150px]"
        value={ownerKind}
        onChange={(v) => patch({ ownerKind: v })}
        options={[
          { value: '', label: 'All runtimes' },
          ...(facets?.ownerKinds || []).map((k) => ({
            value: k.value,
            label: `${KIND_LABELS[k.value] || k.value} (${k.count})`,
          })),
        ]}
        placeholder="All runtimes"
        searchable={false}
        clearable={false}
      />
      <SearchableSelect
        className="w-[160px]"
        value={environment}
        onChange={(v) => patch({ environment: v })}
        options={[
          { value: '', label: 'All environments' },
          ...ENVIRONMENTS.map((e) => ({ value: e, label: ENVIRONMENT_LABELS[e] || e })),
        ]}
        placeholder="All environments"
        searchable={false}
        clearable={false}
      />
      <SearchableSelect
        className="w-[180px]"
        value={customerId}
        onChange={(v) => patch({ customerId: v })}
        options={[{ value: '', label: 'All customers' }, ...customers.map((c) => ({ value: c.id, label: c.name }))]}
        placeholder="All customers"
        searchable
        clearable={false}
      />
    </>
  );

  const exportButton = canExport ? (
    <Button variant="outline" size="sm" onClick={() => setExportOpen(true)}>
      <Download className="mr-1.5 h-4 w-4" /> Export
    </Button>
  ) : null;

  const serviceColumns = [
    {
      key: 'name',
      label: 'Service',
      searchAccessor: (r) => `${r.name} ${r.kind}`,
      mobile: [
        { slot: 'title', render: (r) => r.name },
        {
          slot: 'secondary',
          key: 'service-kind',
          render: (r) => `${KIND_LABELS[r.kind] || r.kind} · ${r.ports.join(', ')}`,
        },
      ],
      render: (r) => (
        <div className="min-w-0">
          <p className="truncate font-medium text-foreground">{r.name}</p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">{KIND_LABELS[r.kind] || r.kind}</p>
        </div>
      ),
    },
    {
      key: 'serverCount',
      label: 'Hosts',
      className: 'w-24',
      mobile: { slot: 'meta', order: 1, showLabel: true, label: 'hosts' },
      // The list of hostnames is what makes the count actionable — a title,
      // so the answer to "where" does not need a second click.
      render: (r) => (
        <span
          className="tabular-nums text-foreground"
          title={r.servers.map((s) => s.displayName || s.hostname).join('\n')}
        >
          {r.serverCount}
        </span>
      ),
    },
    {
      key: 'ports',
      label: 'Ports',
      sortAccessor: (r) => r.ports[0] ?? null,
      mobile: 'hidden',
      render: (r) => (
        <span className="font-mono text-xs text-muted-foreground">
          {r.protos.join('/').toUpperCase()} {r.ports.slice(0, 6).join(', ')}
          {r.ports.length > 6 ? ` +${r.ports.length - 6}` : ''}
        </span>
      ),
    },
    {
      key: 'environments',
      label: 'Environments',
      hideBelow: 'lg',
      searchAccessor: (r) => r.environments.join(' '),
      mobile: 'hidden',
      render: (r) => (
        <div className="flex flex-wrap gap-1">
          {r.environments.map((e) => (
            <EnvironmentBadge key={e} environment={e} />
          ))}
        </div>
      ),
    },
    {
      key: 'internetExposed',
      label: 'Exposure',
      sortAccessor: (r) => r.internetExposed,
      mobile: {
        slot: 'meta',
        order: 0,
        render: (r) =>
          r.internetExposed > 0 ? <Badge tone="danger">{r.internetExposed} internet</Badge> : null,
      },
      render: (r) =>
        r.internetExposed > 0 ? (
          <Badge tone="danger" icon={Globe}>
            {r.internetExposed} internet-facing
          </Badge>
        ) : (
          <span className="text-xs text-muted-foreground">Internal</span>
        ),
    },
    {
      key: 'openFindings',
      label: 'Findings',
      className: 'w-28',
      sortAccessor: (r) => r.criticalOrHigh * 1000 + r.openFindings,
      mobile: {
        slot: 'meta',
        order: 2,
        render: (r) => (r.openFindings > 0 ? `${r.openFindings} finding${r.openFindings === 1 ? '' : 's'}` : null),
      },
      render: (r) =>
        r.openFindings === 0 ? (
          <span className="text-xs text-muted-foreground">—</span>
        ) : (
          <span className="flex items-center gap-1.5">
            {r.criticalOrHigh > 0 && <ShieldAlert className="h-3.5 w-3.5 text-red-500" />}
            <span className="text-sm tabular-nums text-foreground">{r.openFindings}</span>
          </span>
        ),
    },
  ];

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
        render: (r) => <Badge tone={reachabilityTone(r.reachability).tone}>{reachabilityTone(r.reachability).label}</Badge>,
      },
      render: (r) => {
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
          onClick={() => patch({ tab: 'ports' })}
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
          onClick={() => patch({ tab: 'ports', reachability: 'INTERNET' })}
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

      <div className="flex items-center gap-1 overflow-x-auto border-b border-border">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => patch({ tab: t.key === 'services' ? null : t.key })}
            className={[
              'shrink-0 whitespace-nowrap px-2.5 py-2.5 text-sm font-medium transition-colors md:px-4',
              tab === t.key ? 'border-b-2 border-primary text-foreground' : 'text-muted-foreground hover:text-foreground',
            ].join(' ')}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'services' ? (
        <DataTable
          columns={serviceColumns}
          data={services?.items || []}
          loading={loading}
          filters={filterSlot}
          toolbarActions={exportButton}
          activeFilterCount={activeFilterCount}
          onResetFilters={resetFilters}
          searchPlaceholder="Search service, host or port..."
          onSearchChange={(value) => patch({ q: value })}
          // One host: go straight there. Several: switch to the port list
          // filtered to this service, which is the actual "where" answer.
          onRowClick={(r) =>
            r.serverCount === 1
              ? openServer(r.servers[0].id)
              : patch({ tab: 'ports', service: r.key })
          }
          emptyState={
            <EmptyState
              icon={Boxes}
              title={activeFilterCount || q ? 'Nothing matches these filters' : 'No services reported yet'}
              description={
                activeFilterCount || q
                  ? 'Try a different runtime, environment or customer.'
                  : 'Services appear here once hosts run the posture collector. Install it from Servers → Install collectors.'
              }
              action={
                activeFilterCount || q
                  ? { label: 'Reset filters', onClick: resetFilters }
                  : { label: 'Go to servers', onClick: () => navigate('/servers') }
              }
            />
          }
          mobile={{ titleClamp: 1 }}
        />
      ) : (
        <DataTable
          columns={listenerColumns}
          data={listeners?.items || []}
          loading={loading}
          filters={filterSlot}
          toolbarActions={exportButton}
          activeFilterCount={activeFilterCount}
          onResetFilters={resetFilters}
          searchPlaceholder="Search port, service, host or owner..."
          onSearchChange={(value) => patch({ q: value })}
          onRowClick={(r) => r.server?.id && openServer(r.server.id)}
          emptyState={
            <EmptyState
              icon={Network}
              title={activeFilterCount || q ? 'No ports match these filters' : 'No listening ports reported'}
              description={
                activeFilterCount || q
                  ? 'Try a different protocol, reachability or environment.'
                  : 'Ports appear here once hosts run the posture collector.'
              }
              action={activeFilterCount || q ? { label: 'Reset filters', onClick: resetFilters } : undefined}
            />
          }
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
            accent: (r) => (r.reachability === 'INTERNET' ? { tone: 'danger' } : null),
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
