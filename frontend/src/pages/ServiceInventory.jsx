import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Boxes,
  Download,
  Globe,
  Info,
  Network,
  Server as ServerIcon,
  ShieldAlert,
} from 'lucide-react';
import PageHeader from '@/components/common/PageHeader';
import DataTable from '@/components/shared/DataTable';
import GroupedView, { GroupLeafTable } from '@/components/shared/GroupedView';
import EmptyState from '@/components/ui/EmptyState';
import MetricCard from '@/components/dashboard/MetricCard';
import EnvironmentBadge from '@/components/shared/EnvironmentBadge';
import ServerName, { serverSearchString } from '@/components/shared/ServerName';
import SeverityBadge from '@/components/posture/SeverityBadge';
import ExportDialog from '@/components/posture/ExportDialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { reachabilityTone, severityTone, SEVERITY_ORDER } from '@/lib/badgeTones';
import { appliedFilterCount } from '@/lib/filters';
import { can } from '@/lib/permissions';
import { useAuth } from '@/context/AuthContext';
import { fromState } from '@/hooks/useBackTarget';
import { useBreadcrumbs } from '@/context/BreadcrumbContext';
import {
  getInventoryFacets,
  listInventoryListenerGroups,
  listInventoryListeners,
  listInventoryServices,
} from '@/services/postureService';
import { listCustomers } from '@/services/customerService';
import BulkInstallModal from '@/components/servers/BulkInstallModal';
import { ENVIRONMENT_LABELS } from '@/lib/labels';
import useAutoRefresh from '@/hooks/useAutoRefresh';
import useUrlFilters from '@/hooks/useUrlFilters';
import useGroupBy from '@/hooks/useGroupBy';
import { NONE, groupFilters } from '@/lib/grouping';
import { describeListener } from '@/lib/serviceIdentity';
import ServiceCell, { RuntimeChip } from '@/components/posture/ServiceCell';

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

/**
 * The Type filter's options — the same runtime grouping the Type column
 * renders (lib/serviceIdentity.js RUNTIMES). `container` and `docker-proxy`
 * have no filter value of their own: a socket owned by either one is a
 * Docker-published port as far as anyone filtering the page is concerned,
 * so picking "Docker" sends `ownerKinds=docker,docker-proxy,container` —
 * the backend filters on the whole set, not one raw kind at a time.
 */
const TYPE_GROUPS = [
  { key: 'docker', label: 'Docker', ownerKinds: ['docker', 'docker-proxy', 'container'] },
  { key: 'podman', label: 'Podman', ownerKinds: ['podman'] },
  { key: 'pm2', label: 'pm2', ownerKinds: ['pm2'] },
  { key: 'systemd', label: 'systemd', ownerKinds: ['systemd', 'systemd-user'] },
  { key: 'process', label: 'Process', ownerKinds: ['process'] },
  { key: 'unknown', label: 'Unknown', ownerKinds: ['unknown'] },
];

/**
 * Group-by levels for the port list (backend postureInventoryService
 * LISTENER_GROUP_DIMS). The tree is counted over the whole filtered set on
 * the server; a group's rows come from the ordinary list call with each
 * level's value added as the filter below (GROUP_PARAM; the key itself when
 * absent).
 */
const GROUP_OPTIONS = [
  { value: 'server', label: 'Server' },
  { value: 'customer', label: 'Customer' },
  { value: 'environment', label: 'Environment' },
  { value: 'type', label: 'Type' },
  { value: 'protocol', label: 'Service protocol' },
  { value: 'port', label: 'Port' },
  { value: 'proto', label: 'Transport' },
  { value: 'reachability', label: 'Reachability' },
  { value: 'status', label: 'State' },
  { value: 'findings', label: 'Findings' },
];

const GROUP_PARAM = {
  server: 'serverId',
  customer: 'customerId',
  type: 'ownerKind',
  protocol: 'service',
  findings: 'hasFindings',
};

const groupDimLabel = (dim) => GROUP_OPTIONS.find((o) => o.value === dim)?.label || dim;

/** A group header's label: the same chip or badge the column shows. */
function renderGroupLabel(node) {
  if (node.value === NONE) return <span className="text-muted-foreground">{node.label}</span>;
  switch (node.dim) {
    case 'environment':
      return <EnvironmentBadge environment={node.value} />;
    case 'type': {
      const runtime = describeListener({ ownerKind: node.value }).runtime;
      return (
        <>
          <RuntimeChip runtime={runtime} />
          {/* container / docker-proxy both read "Docker": say which one. */}
          {runtime.key !== node.value && (
            <span className="font-mono text-xs text-muted-foreground">{node.value}</span>
          )}
        </>
      );
    }
    case 'reachability': {
      const { tone, label } = reachabilityTone(node.value);
      return <Badge tone={tone}>{label}</Badge>;
    }
    case 'port':
      return <span className="font-mono">{node.label}</span>;
    default:
      return node.label;
  }
}

const FILTER_DEFAULTS = {
  q: '',
  proto: '',
  reachability: '',
  type: '',
  state: '',
  environment: '',
  customerId: '',
  serverId: '',
  port: '',
  portMin: '',
  portMax: '',
  hasFindings: '',
  findingSeverity: '',
  // The service-key chip a link from another page (or a service's own "view
  // instances" action) arrives with — kept separate from the Filters drawer,
  // shown as its own dismissible banner below.
  service: '',
  // Column sort, server-side (whitelisted by the backend).
  sortBy: '',
  sortDir: 'asc',
  page: '1',
};

/** A text filter meant to be a port number — digits only, clamped to a valid port. */
function sanitizePort(value) {
  if (value === undefined || value === null || value === '') return '';
  const digits = String(value).replace(/[^0-9]/g, '');
  if (!digits) return '';
  return String(Math.min(65535, Math.max(0, parseInt(digits, 10))));
}

function ServiceInventory() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const canExport = can(user, 'posture.export');
  const canOnboard = can(user, 'servers.onboard');
  const [bulkInstallOpen, setBulkInstallOpen] = useState(false);
  const [f, setF, clearF] = useUrlFilters(FILTER_DEFAULTS);

  const {
    q, proto, reachability, type, state, environment, customerId, serverId,
    port, portMin, portMax, hasFindings, findingSeverity, service: serviceKey,
  } = f;
  const page = Math.max(parseInt(f.page, 10) || 1, 1);

  const [services, setServices] = useState(null);
  const [listeners, setListeners] = useState(null);
  const [facets, setFacets] = useState(null);
  const [customers, setCustomers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [pageSize, setPageSize] = useState(25);
  const [exportOpen, setExportOpen] = useState(false);
  const [groupKeys, setGroupKeys] = useGroupBy('shellius.services.groupBy', GROUP_OPTIONS);
  const grouped = groupKeys.length > 0;
  const groupSig = groupKeys.join(',');
  const [groups, setGroups] = useState({ tree: null, loading: false, error: '' });
  // Bumped by every refresh (button or auto) so open groups re-read their rows.
  const [refreshTick, setRefreshTick] = useState(0);

  useBreadcrumbs([{ label: 'Services & ports' }]);

  const typeGroup = TYPE_GROUPS.find((g) => g.key === type);

  // Shared by both views and by the export, so the file can never describe a
  // different set of rows than the screen.
  const filters = useMemo(
    () => ({
      q: q || undefined,
      proto: proto || undefined,
      reachability: reachability || undefined,
      ownerKinds: typeGroup ? typeGroup.ownerKinds.join(',') : undefined,
      environment: environment || undefined,
      customerId: customerId || undefined,
      serverId: serverId || undefined,
      port: port || undefined,
      portMin: portMin || undefined,
      portMax: portMax || undefined,
      hasFindings: hasFindings || undefined,
      findingSeverity: findingSeverity || undefined,
      serviceKey: serviceKey || undefined,
      state: state || undefined,
    }),
    [
      q, proto, reachability, typeGroup, environment, customerId, serverId,
      port, portMin, portMax, hasFindings, findingSeverity, serviceKey, state,
    ]
  );

  // The column sort, in the URL like every other filter. The backend
  // whitelists the key; an unknown one falls back to the default order.
  const sortParams = useMemo(
    () => (f.sortBy ? { sortBy: f.sortBy, sortDir: f.sortDir === 'desc' ? 'desc' : 'asc' } : {}),
    [f.sortBy, f.sortDir]
  );

  const load = useCallback(async (isFirstLoad) => {
    if (isFirstLoad) setLoading(true);
    setError('');
    if (grouped) setGroups((g) => ({ ...g, loading: true, error: '' }));
    try {
      // The grouped call feeds the tiles only. One grid was showing the same
      // rows twice under two tab names — but "how many distinct services"
      // still has to come from the grouping, not from a page of ports.
      // While grouped, the group tree replaces the flat page: it is counted
      // over the whole filtered set, and each open group loads its own rows.
      const [rows, summaryData, tree] = await Promise.all([
        grouped ? Promise.resolve(null) : listInventoryListeners({ ...filters, ...sortParams, page, limit: pageSize }),
        listInventoryServices(filters),
        grouped
          ? listInventoryListenerGroups({ ...filters, groupBy: groupSig }).catch((err) => {
              setGroups({
                tree: null,
                loading: false,
                error: err.response?.data?.error?.message || err.message || 'Could not load the groups',
              });
              return undefined;
            })
          : Promise.resolve(undefined),
      ]);
      if (rows) setListeners(rows);
      setServices(summaryData);
      if (tree) setGroups({ tree: tree.tree || [], loading: false, error: '' });
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message || 'Could not load the inventory');
      if (grouped) setGroups((g) => ({ ...g, loading: false }));
    } finally {
      setLoading(false);
    }
  }, [filters, sortParams, page, pageSize, grouped, groupSig]);

  useEffect(() => {
    load(listeners === null && services === null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters, sortParams, page, pageSize, groupSig]);

  const fetchFacets = useCallback(async () => {
    await Promise.all([
      getInventoryFacets().then(setFacets).catch(() => setFacets(null)),
      listCustomers({ page: 1, pageSize: 200 })
        .then((d) => setCustomers(d.items || []))
        .catch(() => setCustomers([])),
    ]);
  }, []);
  useEffect(() => { fetchFacets(); }, [fetchFacets]);

  const loadAll = useCallback(async () => {
    setRefreshTick((n) => n + 1);
    await Promise.all([load(false), fetchFacets()]);
  }, [load, fetchFacets]);
  const { refresh, refreshing, lastUpdated } = useAutoRefresh(loadAll);

  // The services view always loads the whole grouped set, so its totals are
  // the honest fleet numbers rather than a page's worth.
  const summary = services?.meta;

  // Any filter change narrows a different set of rows, so page 4 of the
  // last query is not page 4 of this one. Port fields are also sanitised
  // here — a text input the caller types freely into, clamped to a real
  // port number rather than shipped straight to the API.
  const patchFilters = useCallback(
    (next) => {
      const clean = { ...next };
      for (const key of ['port', 'portMin', 'portMax']) {
        if (key in clean) clean[key] = sanitizePort(clean[key]);
      }
      setF({ ...clean, page: '1' });
    },
    [setF]
  );

  const setPage = useCallback((n) => setF({ page: String(n) }), [setF]);

  // Clearing filters keeps the column sort: it is how the reader looks at
  // the rows, not which rows they asked for.
  const resetFilters = () => clearF(['page', 'sortBy', 'sortDir']);

  const handleSortChange = useCallback(
    (sortBy, sortDir) => setF({ sortBy, sortDir, page: '1' }),
    [setF]
  );
  const serverSort = { sortKey: f.sortBy, sortDir: f.sortDir === 'desc' ? 'desc' : 'asc', onSortChange: handleSortChange };

  // Declarative: DataTable renders these behind one "Filters" button, in a
  // drawer, as a draft until Apply. Six selects in a row above the table
  // wrapped onto two lines on a laptop and fired a request per change.
  const filterDefs = [
    {
      key: 'serverId',
      label: 'Server',
      placeholder: 'All servers',
      type: 'entity',
      entity: 'servers',
    },
    {
      key: 'type',
      label: 'Type',
      placeholder: 'All types',
      options: [
        { value: '', label: 'All types' },
        ...TYPE_GROUPS.map((g) => {
          const count = (facets?.ownerKinds || [])
            .filter((k) => g.ownerKinds.includes(k.value))
            .reduce((n, k) => n + k.count, 0);
          return { value: g.key, label: count ? `${g.label} (${count})` : g.label };
        }),
      ],
    },
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
      key: 'port',
      label: 'Port',
      placeholder: 'e.g. 8080',
      type: 'text',
    },
    {
      key: 'portMin',
      label: 'Port range — from',
      placeholder: 'e.g. 1024',
      type: 'text',
    },
    {
      key: 'portMax',
      label: 'Port range — to',
      placeholder: 'e.g. 65535',
      type: 'text',
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
      key: 'hasFindings',
      label: 'Has findings',
      placeholder: 'Any',
      options: [
        { value: '', label: 'Any' },
        { value: 'true', label: 'Has open findings' },
      ],
    },
    {
      key: 'findingSeverity',
      label: 'Finding severity',
      placeholder: 'Any severity',
      options: [
        { value: '', label: 'Any severity' },
        ...SEVERITY_ORDER.map((s) => ({ value: s.toUpperCase(), label: severityTone(s).label })),
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

  const filterValues = {
    serverId, type, proto, reachability, port, portMin, portMax, state,
    hasFindings, findingSeverity, environment, customerId,
  };

  // Counts exactly what the drawer shows — nothing more, nothing fewer —
  // computed with the same function the drawer's own chip uses, so the two
  // can never disagree about what "3 filters applied" means.
  const activeFilterCount = appliedFilterCount(filterDefs, filterValues);
  const filtered = !!(activeFilterCount || q || serviceKey);

  const emptyState = (
    <EmptyState
      icon={Network}
      title="No services reported yet"
      description={
        canOnboard
          ? 'Services appear here once hosts run the posture collector.'
          : 'Services appear here once hosts run the posture collector. Someone with onboarding rights can install it from Servers.'
      }
      action={
        canOnboard
          ? // A pointer to another page is not an action. The thing that
            // fills this page is one button away.
            { label: 'Install collectors', onClick: () => setBulkInstallOpen(true) }
          : { label: 'Go to servers', onClick: () => navigate('/servers') }
      }
    />
  );

  // A filtered result of zero stays INSIDE the table — same border, same
  // header row, same "Filters" button — rather than replacing the whole
  // DataTable with a full-page EmptyState. Losing the toolbar along with the
  // rows meant "Clear filters" was nowhere on screen.
  const filteredEmptyState = (
    <div className="flex flex-col items-center gap-1.5 py-4 text-sm text-muted-foreground">
      <span>No results match these filters.</span>
      <button type="button" onClick={resetFilters} className="text-primary hover:underline">
        Clear filters
      </button>
    </div>
  );

  const exportButton = canExport ? (
    <Button variant="outline" size="sm" onClick={() => setExportOpen(true)}>
      <Download className="mr-1.5 h-4 w-4" /> Export
    </Button>
  ) : null;

  const listenerColumns = [
    {
      key: 'service',
      label: 'Service',
      // Same readable cell as a server's Ports tab: the name, the recognised
      // protocol when it adds something, and where it is defined underneath.
      sortAccessor: (r) => describeListener(r).name.toLowerCase(),
      searchAccessor: (r) => {
        const d = describeListener(r);
        return [d.name, d.runtime.label, d.protocol, d.subtext, d.id, d.details.user].join(' ');
      },
      // Phones lead with the service's name too, as the desktop column does.
      mobile: { slot: 'title', render: (r) => describeListener(r).name },
      render: (r) => <ServiceCell listener={r} />,
    },
    {
      key: 'type',
      label: 'Type',
      className: 'w-32',
      sortAccessor: (r) => describeListener(r).runtime.label,
      mobile: 'hidden',
      render: (r) => <RuntimeChip runtime={describeListener(r).runtime} />,
    },
    {
      key: 'port',
      label: 'Port',
      className: 'w-24',
      sortAccessor: (r) => r.port,
      mobile: {
        slot: 'secondary',
        render: (r) => {
          const d = describeListener(r);
          return `${(r.proto || '').toUpperCase()}/${r.port} · ${d.runtime.label}${d.protocol ? ` · ${d.protocol}` : ''}`;
        },
      },
      render: (r) => <span className="font-mono text-sm">{r.port}</span>,
    },
    {
      key: 'proto',
      label: 'Protocol',
      className: 'w-24',
      hideBelow: 'sm',
      mobile: 'hidden',
      render: (r) => (
        <span className="inline-flex items-center rounded border border-border px-1.5 py-px font-mono text-[11px] uppercase text-muted-foreground">
          {r.proto}
        </span>
      ),
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
              {r.findings.map((f2) => (
                <SeverityBadge key={f2.id} severity={f2.severity} />
              ))}
            </span>
          ),
      },
      render: (r) =>
        (r.findings || []).length === 0 ? (
          <span className="text-xs text-muted-foreground">—</span>
        ) : (
          <div className="flex flex-wrap gap-1">
            {r.findings.map((f2) => (
              <SeverityBadge key={f2.id} severity={f2.severity} />
            ))}
          </div>
        ),
    },
  ];

  // Carries where you came from, so Server Details offers "Back to Services
  // & ports" rather than dropping you on the servers list.
  const openServer = (id) =>
    navigate(`/servers/${id}?tab=ports`, { state: fromState('/services', 'Services & ports') });
  const onRowClick = (r) => r.server?.id && openServer(r.server.id);
  const mobileOptions = {
    accent: (r) =>
      r.listening === false
        ? { tone: 'warning' }
        : r.reachability === 'INTERNET'
          ? { tone: 'danger' }
          : null,
  };

  // A group's rows: the page's own list call, with every level's value on
  // the way down added as a filter. A Type level names one raw ownerKind,
  // which must REPLACE the Type filter's ownerKinds set rather than join it
  // (the backend unions the two) — the group was counted under that filter,
  // so its kind is already inside it.
  const leafFilters = (path) => {
    const g = groupFilters(path, GROUP_PARAM);
    const out = { ...filters, ...g };
    if ('ownerKind' in g) delete out.ownerKinds;
    return out;
  };
  const leafReloadKey = `${refreshTick}|${JSON.stringify(filters)}|${f.sortBy}|${f.sortDir}`;

  const groupedContent = (
    <GroupedView
      tree={groups.tree}
      loading={groups.loading}
      error={groups.error}
      dimLabel={groupDimLabel}
      renderLabel={renderGroupLabel}
      emptyMessage={filtered ? 'No results match these filters.' : 'No services reported yet.'}
      renderLeaf={(node, path) => (
        <GroupLeafTable
          columns={listenerColumns}
          serverSort={serverSort}
          onRowClick={onRowClick}
          mobile={mobileOptions}
          reloadKey={leafReloadKey}
          fetchPage={({ page: leafPage, pageSize: leafSize }) =>
            listInventoryListeners({ ...leafFilters(path), ...sortParams, page: leafPage, limit: leafSize }).then(
              (r) => ({ items: r?.items || [], total: r?.meta?.total ?? 0 })
            )
          }
        />
      )}
    />
  );

  const nothingReported = grouped
    ? Array.isArray(groups.tree) && groups.tree.length === 0
    : (listeners?.items || []).length === 0;

  return (
    <div className="space-y-5 p-6 max-md:p-4 sm:space-y-6">
      <PageHeader
        icon={Network}
        title="Services & ports"
        subtitle="Every service listening across the fleet, and where it runs."
        onRefresh={refresh}
        refreshing={refreshing}
        lastUpdated={lastUpdated}
        actions={[
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
          onClick={() => patchFilters({ reachability: 'INTERNET' })}
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
          <button type="button" onClick={() => setF({ service: null, page: '1' })} className="text-xs text-primary hover:underline">
            Show everything
          </button>
        </div>
      )}

      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* A truly empty fleet (never reported anything, no filter narrowing it)
          replaces the table with a full-page EmptyState — the same split as
          MyHosts / Roles / Posture. A FILTERED zero stays inside the table
          (see `filteredEmptyState` below), so the toolbar (search + Filters)
          is never the thing that disappears along with the rows. */}
      {!loading && !filtered && nothingReported ? (
        emptyState
      ) : (
      <DataTable
        columns={listenerColumns}
        data={listeners?.items || []}
        loading={loading}
        emptyState={filtered ? filteredEmptyState : undefined}
        filterDefs={filterDefs}
        filterValues={filterValues}
        onFilterChange={patchFilters}
        toolbarActions={exportButton}
        searchPlaceholder="Search service, port, host, owner or customer..."
        initialSearch={q}
        onSearchChange={(value) => patchFilters({ q: value })}
        onRowClick={onRowClick}
        serverSort={serverSort}
        grouping={{ keys: groupKeys, onChange: setGroupKeys, options: GROUP_OPTIONS }}
        groupedContent={groupedContent}
        serverPagination={{
          page,
          total: listeners?.meta?.total ?? 0,
          onPageChange: setPage,
          pageSize,
          onPageSizeChange: (size) => {
            setPageSize(size);
            setF({ page: '1' });
          },
        }}
        mobile={mobileOptions}
      />
      )}

      <ExportDialog
        open={exportOpen}
        dataset="listeners"
        filters={{ ...filters, ...sortParams }}
        serverCount={summary?.servers ?? 1}
        scopeLabel="the listening ports matching these filters"
        onClose={() => setExportOpen(false)}
      />

      {canOnboard && (
        <BulkInstallModal
          open={bulkInstallOpen}
          serverIds={[]}
          onClose={() => setBulkInstallOpen(false)}
        />
      )}
    </div>
  );
}

export default ServiceInventory;
