import { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import {
  ArrowLeft,
  MoreHorizontal,
  Pencil,
  Trash2,
  Plus,
  Server,
  CheckCircle,
  XCircle,
  HelpCircle,
  Building2,
  Eye,
  Activity,
  Calendar,
  Clock,
  Terminal as TerminalIcon,
  Monitor,
  RefreshCw,
  ExternalLink,
  Shield,
  Radar,
} from 'lucide-react';
import { SshTrustBadge, CollectorBadge } from '@/components/servers/HostAgentStatus';
import useAutoRefresh from '@/hooks/useAutoRefresh';
import DataTable from '@/components/shared/DataTable';
import { CardIcon, MobileCardSkeleton } from '@/components/mobile/MobileCard';
import Modal from '@/components/shared/Modal';
import ConfirmDialog from '@/components/shared/ConfirmDialog';
import DeleteCustomerDialog from '@/components/customers/DeleteCustomerDialog';
import EnvironmentBadge from '@/components/shared/EnvironmentBadge';
import HealthStatusDot, { HEALTH_COLORS, HEALTH_LABELS } from '@/components/shared/HealthStatusDot';
import { envAccent } from '@/lib/mobileCard';
import CustomerForm from '@/components/customers/CustomerForm';
import ServerForm from '@/components/servers/ServerForm';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import SearchableSelect from '@/components/ui/SearchableSelect';
import {
  getCustomer,
  updateCustomer,
  deleteCustomer,
  getCustomerStats,
} from '@/services/customerService';
import { listServers, createServer } from '@/services/serverService';
import { listSessions } from '@/services/sessionService';
import { relativeTime, formatDateTime } from '@/utils/time';
import Skeleton from '@/components/ui/Skeleton';
import MobilePageHeader from '@/components/mobile/MobilePageHeader';
import { fromState } from '@/hooks/useBackTarget';
import { getPostureSummary } from '@/services/postureService';
import BulkInstallModal from '@/components/servers/BulkInstallModal';
import CustomerPostureWidget from '@/components/posture/CustomerPostureWidget';
import { useBreadcrumbs } from '@/context/BreadcrumbContext';
import useIsMobile from '@/hooks/useIsMobile';
import SectionHeading from '@/components/common/SectionHeading';
import { useAuth } from '@/context/AuthContext';
import { can } from '@/lib/permissions';
import { ENVIRONMENT_LABELS } from '@/lib/labels';

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

// `shortLabel`: phones, where two tiles share a row and a long label wrapped.
function StatTile({ icon: Icon, label, shortLabel, value, iconClass, loading }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-card p-4 max-md:p-3">
      <div
        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-md ${iconClass}`}
      >
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0">
        <p className="truncate text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {shortLabel ? (
            <>
              <span className="md:hidden">{shortLabel}</span>
              <span className="max-md:hidden">{label}</span>
            </>
          ) : (
            label
          )}
        </p>
        {loading ? (
          <Skeleton className="mt-1 h-5 w-10" />
        ) : (
          <p className="text-lg font-semibold leading-tight text-foreground">{value}</p>
        )}
      </div>
    </div>
  );
}

function SectionCard({ title, description, children, action }) {
  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="flex items-center justify-between border-b border-border px-5 py-4">
        <div>
          <h2 className="text-sm font-semibold text-foreground">{title}</h2>
          {description && (
            <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
          )}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      <div className="px-5 py-4">{children}</div>
    </div>
  );
}

function MetaRow({ label, children }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-border py-3 last:border-0">
      <dt className="w-28 shrink-0 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="flex-1 break-all text-sm text-foreground">{children}</dd>
    </div>
  );
}

// Loading skeleton for the hero + stat tiles
function HeroSkeleton() {
  return (
    <div className="space-y-5">
      {/* breadcrumb */}
      <Skeleton className="h-4 w-32" />
      {/* heading row */}
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-2">
          <Skeleton className="h-8 w-56" />
          <Skeleton className="h-4 w-80" />
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-9 w-28" />
          <Skeleton className="h-9 w-9" />
        </div>
      </div>
      {/* stat tiles */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[...Array(4)].map((_, i) => (
          <Skeleton key={i} className="h-16 rounded-lg" />
        ))}
      </div>
    </div>
  );
}

const ENVIRONMENTS = ['demo', 'dev', 'staging', 'prod'];

const ENV_DOT_COLORS = {
  demo: 'bg-muted-foreground/60',
  dev: 'bg-blue-500',
  staging: 'bg-amber-500',
  prod: 'bg-red-500',
};

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------


function CustomerDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const canAddServer = can(user, 'servers.create');
  const canManage = can(user, 'customers.update');
  const canDelete = can(user, 'customers.delete');
  const isMobile = useIsMobile();

  const [customer, setCustomer] = useState(null);
  const [stats, setStats] = useState(null);
  const [servers, setServers] = useState([]);
  const [activeSessions, setActiveSessions] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [editOpen, setEditOpen] = useState(false);
  const [addServerOpen, setAddServerOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // server table filters
  const [envFilter, setEnvFilter] = useState('');
  const [posture, setPosture] = useState(null);

  const loadData = useCallback(async ({ quiet = false } = {}) => {
    if (!quiet) setLoading(true);
    setError('');
    try {
      const [c, s, srv, sessions] = await Promise.all([
        getCustomer(id),
        getCustomerStats(id).catch(() => null),
        listServers({ customerId: id, page: 1, pageSize: 200 }).catch(() => ({ items: [] })),
        can(user, 'sessions.view_all')
          ? listSessions({ customerId: id, status: 'ACTIVE', page: 1, pageSize: 1 }).catch(() => null)
          : null,
      ]);
      setCustomer(c);
      setStats(s);
      setServers(srv.items || []);
      // sessions response envelope: { data: { items, total } } or { items, total }
      const sessionTotal =
        sessions?.data?.total ?? sessions?.data?.data?.total ?? sessions?.total ?? 0;
      setActiveSessions(sessionTotal);
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message || 'Failed to load customer');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Same as the Servers list: poll quietly while a host here is mid-install.
  const pendingHere = servers.some(
    (sv) => sv.collector?.state === 'awaiting_report' || sv.sshTrust?.state === 'installing'
  );
  const quietLoad = useCallback(() => loadData({ quiet: true }), [loadData]);
  const { refresh, refreshing, lastUpdated } = useAutoRefresh(quietLoad, { interval: 15000, enabled: pendingHere });

  const handleEdit = async (payload) => {
    await updateCustomer(id, payload);
    setEditOpen(false);
    loadData();
  };

  const handleDelete = async () => {
    try {
      await deleteCustomer(id);
      navigate('/customers');
    } catch (err) {
      setError(err.response?.data?.error?.message || 'Failed to delete customer');
      setConfirmDelete(false);
    }
  };

  const handleAddServer = async (payload) => {
    await createServer(payload);
    setAddServerOpen(false);
    loadData();
  };

  // Derived values
  const byHealth = stats?.byHealth || {};
  const byEnv = stats?.byEnvironment || {};
  const total = stats?.total ?? customer?._count?.servers ?? servers.length;

  const healthyCount = byHealth.healthy || 0;
  const unhealthyCount = byHealth.unhealthy || 0;
  const unknownCount = byHealth.unknown || 0;

  // Latest health check across all servers
  const lastHealthCheck = useMemo(() => {
    if (!servers.length) return null;
    const dates = servers
      .map((s) => s.lastHealthCheck)
      .filter(Boolean)
      .map((d) => new Date(d).getTime())
      .filter((t) => !isNaN(t));
    return dates.length ? Math.max(...dates) : null;
  }, [servers]);

  useBreadcrumbs([
    { label: 'Customers', to: '/customers' },
    customer ? { label: customer.name } : null,
  ]);

  const canViewPosture = can(user, 'posture.read');
  const canOnboard = can(user, 'servers.onboard');
  const [bulkInstallOpen, setBulkInstallOpen] = useState(false);
  // Set when the installer is opened from ONE host's status badge or row
  // action: just that host, ticked, on the install it needs.
  const [singleInstall, setSingleInstall] = useState(null); // { id, mode }
  useEffect(() => {
    if (!canViewPosture || !id) return;
    // Best-effort: this page is about the customer, and posture is one panel
    // on it — a posture outage should not take the page with it.
    getPostureSummary({ customerId: id }).then(setPosture).catch(() => setPosture(null));
  }, [id, canViewPosture]);

  // Filtered servers for table
  const filteredServers = useMemo(() => {
    if (!envFilter) return servers;
    return servers.filter((s) => s.environment === envFilter);
  }, [servers, envFilter]);

  // Server table columns
  const serverColumns = [
    {
      key: 'hostname',
      label: 'Server',
      sortable: true,
      searchAccessor: (r) => `${r.displayName || ''} ${r.hostname} ${r.ipAddress || ''}`,
      mobile: { slot: 'title', render: (r) => r.displayName || r.hostname },
      render: (r) => {
        const proto = r.protocol || r.type || 'SSH';
        const ProtoIcon = proto === 'RDP' ? Monitor : TerminalIcon;
        const primary = r.displayName || r.hostname;
        const showHost = r.displayName && r.hostname && r.displayName !== r.hostname;
        return (
          <button
            onClick={() => navigate(`/servers/${r.id}`, { state: fromState(`/customers/${id}`, customer?.name || 'customer') })}
            className="flex items-center gap-2 text-left hover:text-primary"
          >
            <ProtoIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="flex flex-col leading-tight">
              <span className="font-medium text-foreground">{primary}</span>
              {showHost && <span className="text-xs text-muted-foreground">{r.hostname}</span>}
            </span>
          </button>
        );
      },
    },
    {
      key: 'ipAddress',
      label: 'IP',
      mobile: {
        slot: 'secondary',
        render: (r) => (
          <span className="break-all font-mono text-[11px]">
            {[r.displayName && r.displayName !== r.hostname ? r.hostname : null, r.ipAddress].filter(Boolean).join(' · ') || '-'}
          </span>
        ),
      },
      render: (r) => (
        <span className="font-mono text-xs text-muted-foreground">{r.ipAddress || '-'}</span>
      ),
    },
    {
      key: 'protocol',
      label: 'Proto',
      mobile: {
        slot: 'leading',
        render: (r) => {
          const health = r.healthStatus || 'unknown';
          return (
            <CardIcon
              icon={r.protocol === 'rdp' ? Monitor : TerminalIcon}
              title={r.protocol}
              status={HEALTH_COLORS[health] || HEALTH_COLORS.unknown}
              statusLabel={HEALTH_LABELS[health] || 'Unknown'}
            />
          );
        },
      },
      render: (r) => (
        <span className="text-xs uppercase tracking-wide text-muted-foreground">
          {r.protocol || 'SSH'}
        </span>
      ),
    },
    {
      key: 'environment',
      label: 'Env',
      sortable: true,
      searchAccessor: (r) => r.environment || '',
      // Phones: the card tint + bottom-left label (DataTable `mobile.accent`).
      mobile: 'hidden',
      render: (r) => <EnvironmentBadge environment={r.environment} />,
    },
    {
      key: 'health',
      label: 'Health',
      searchAccessor: (r) => r.healthStatus || '',
      // Phones: a dot on the card icon; spelled out only when something's wrong.
      mobile: {
        slot: 'meta',
        order: 2,
        render: (r) =>
          r.healthStatus === 'unhealthy' || r.healthStatus === 'maintenance' ? (
            <HealthStatusDot status={r.healthStatus} showLabel />
          ) : null,
      },
      render: (r) => <HealthStatusDot status={r.healthStatus} showLabel />,
    },
    {
      key: 'sshTrust',
      label: 'SSH trust',
      hideBelow: 'md',
      searchAccessor: (r) => r.sshTrust?.label || '',
      mobile: 'hidden',
      render: (r) => (
        <SshTrustBadge server={r} canFix={canOnboard} onFix={() => setSingleInstall({ id: r.id, mode: 'full' })} />
      ),
    },
    {
      key: 'collector',
      label: 'Collector',
      hideBelow: 'md',
      searchAccessor: (r) => r.collector?.label || '',
      mobile: {
        slot: 'meta',
        order: 4,
        render: (r) => (r.collector && r.collector.tone !== 'success' && r.collector.tone !== 'neutral' ? <CollectorBadge server={r} /> : null),
      },
      render: (r) => (
        <CollectorBadge server={r} canFix={canOnboard} onFix={() => setSingleInstall({ id: r.id, mode: 'posture' })} />
      ),
    },
    {
      key: 'lastCheck',
      label: 'Last check',
      hideBelow: 'md',
      mobile: { slot: 'meta', order: 3, render: (r) => (r.lastHealthCheck ? `Checked ${relativeTime(r.lastHealthCheck)}` : null) },
      render: (r) => (
        <span className="text-xs text-muted-foreground">
          {relativeTime(r.lastHealthCheck)}
        </span>
      ),
    },
    {
      key: 'actions',
      label: '',
      className: 'w-10',
      actions: [
        {
          label: 'View details',
          icon: Eye,
          onClick: (r) => navigate(`/servers/${r.id}`, { state: fromState(`/customers/${id}`, customer?.name || 'customer') }),
        },
        ...(canOnboard
          ? [
              {
                label: 'Reinstall posture collector',
                icon: Radar,
                hidden: (r) => r.collector?.state === 'not_applicable',
                onClick: (r) => setSingleInstall({ id: r.id, mode: 'posture' }),
              },
            ]
          : []),
      ],
    },
  ];

  // Environment filter slot for DataTable
  const filterSlot = (
    <SearchableSelect
      className="w-[160px]"
      value={envFilter || ''}
      onChange={(v) => setEnvFilter(v)}
      placeholder="All environments"
      searchable={false}
      clearable={false}
      options={[
        { value: '', label: 'All environments' },
        ...ENVIRONMENTS.map((e) => ({ value: e, label: ENVIRONMENT_LABELS[e] || e })),
      ]}
    />
  );

  // ---------------------------------------------------------------------------
  // Loading state
  // ---------------------------------------------------------------------------
  if (loading) {
    return (
      <div className="space-y-6 p-6 max-md:p-4">
        <HeroSkeleton />
        {/* table skeleton */}
        <div className="rounded-lg border border-border bg-card">
          <div className="border-b border-border px-5 py-3">
            <Skeleton className="h-4 w-24" />
          </div>
          <div className="p-3 md:hidden">
            <MobileCardSkeleton count={4} withLeading />
          </div>
          <div className="hidden p-4 md:block">
            <table className="w-full">
              <tbody>
                {[...Array(5)].map((_, i) => (
                  <tr key={i} className="border-b border-border last:border-0">
                    {[...Array(6)].map((__, j) => (
                      <td key={j} className="px-3 py-3">
                        <Skeleton className="h-4 w-full max-w-[120px]" />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Error / not-found state
  // ---------------------------------------------------------------------------
  if (error || !customer) {
    return (
      <div className="space-y-4 p-6 max-md:p-4">
        <Link
          to="/customers"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to Customers
        </Link>
        <div className="flex items-start gap-3 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          <span className="flex-1">{error || 'Customer not found.'}</span>
          <button
            onClick={loadData}
            className="shrink-0 inline-flex items-center gap-1 font-medium underline-offset-2 hover:underline"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Retry
          </button>
        </div>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Main render
  // ---------------------------------------------------------------------------
  return (
    <div className="space-y-6 p-6 max-md:p-4">

      {/* ---- ZONE 1: HERO ---- */}

      {isMobile ? (
        <MobilePageHeader
          back={{ to: '/customers', label: 'Back to Customers' }}
          icon={Building2}
          title={customer.name}
          // Phones: one line — the description, or the slug without one.
          // Server counts per environment are in the tiles below.
          subtitle={customer.description || <span className="font-mono">{customer.slug}</span>}
          actions={[
            { key: 'add-server', label: 'Add server', icon: Plus, onClick: () => setAddServerOpen(true), hidden: !canAddServer },
            { key: 'refresh', label: refreshing ? 'Refreshing…' : 'Refresh', icon: RefreshCw, variant: 'outline', onClick: refresh, spin: refreshing, disabled: refreshing },
            { key: 'edit', label: 'Edit customer', icon: Pencil, variant: 'outline', onClick: () => setEditOpen(true), hidden: !canManage },
            { key: 'delete', label: 'Delete customer', icon: Trash2, variant: 'destructive', onClick: () => setConfirmDelete(true), hidden: !canDelete },
          ]}
        />
      ) : (
      <>
      {/* Back link */}
      <Link
        to="/customers"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back to Customers
      </Link>

      {/* Heading row */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1.5">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border bg-card">
              <Building2 className="h-5 w-5 text-primary" />
            </div>
            <div className="min-w-0">
              <h1 className="truncate text-2xl font-bold tracking-tight text-foreground">
                {customer.name}
              </h1>
              {/* The slug and the per-environment counts both have a home
                  further down the page — the slug in Details, the counts in
                  their own tiles. Repeating them here made the header the
                  densest thing on a page whose job is to orient you. */}
              {customer.description && (
                <p className="truncate text-sm text-muted-foreground">{customer.description}</p>
              )}
            </div>
          </div>
        </div>

        {/* Action group */}
        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={refresh}
            disabled={refreshing}
            title={lastUpdated ? `Updated ${relativeTime(lastUpdated)}` : 'Reload this customer’s data'}
          >
            <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
          {canAddServer && (
            <Button size="sm" onClick={() => setAddServerOpen(true)}>
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              Add server
            </Button>
          )}
          {(canManage || canDelete) && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon" className="h-9 w-9">
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                {canManage && (
                  <DropdownMenuItem onClick={() => setEditOpen(true)}>
                    <Pencil className="mr-2 h-4 w-4" />
                    Edit customer
                  </DropdownMenuItem>
                )}
                {canDelete && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onClick={() => setConfirmDelete(true)}
                      className="text-destructive focus:text-destructive"
                    >
                      <Trash2 className="mr-2 h-4 w-4" />
                      Delete customer
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>
      </>
      )}

      {/* ---- ZONE 1a: AT A GLANCE ---- */}
      <section className="space-y-3">
        <SectionHeading>At a glance</SectionHeading>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile
          icon={Server}
          label="Total servers"
          shortLabel="Servers"
          value={total}
          iconClass="bg-primary/10 text-primary"
        />
        {can(user, 'sessions.view_all') && (
          <StatTile
            icon={Activity}
            label="Active sessions"
            shortLabel="Sessions"
            value={activeSessions}
            iconClass="bg-emerald-500/10 text-emerald-500"
          />
        )}
        <StatTile
          icon={CheckCircle}
          label="Healthy"
          value={healthyCount}
          iconClass="bg-emerald-500/10 text-emerald-500"
        />
        <StatTile
          icon={Clock}
          label="Last health check"
          shortLabel="Last check"
          value={lastHealthCheck ? relativeTime(new Date(lastHealthCheck)) : 'Never'}
          iconClass="bg-muted-foreground/10 text-muted-foreground"
        />
      </div>
      </section>

      {/* ---- ZONE 1b: POSTURE ---- */}
      {canViewPosture && posture && (
        <CustomerPostureWidget
          customerId={id}
          posture={posture}
          canOnboard={canOnboard && servers.length > 0}
          onInstall={() => setBulkInstallOpen(true)}
        />
      )}

      {/* ---- ZONE 2: SERVERS (full width) ---- */}
      {/* Not in a card: the grid already has a border, a header row and its
          own pagination, so wrapping it in another bordered box was a box
          inside a box that only narrowed the table. */}
      <section className="space-y-3">
        <SectionHeading
          title="Servers"
          count={`${filteredServers.length}${envFilter ? ` of ${servers.length}` : ''}`}
          action={
            canAddServer ? (
              <Button size="sm" variant="outline" onClick={() => setAddServerOpen(true)}>
                <Plus className="mr-1.5 h-3.5 w-3.5" />
                Add server
              </Button>
            ) : null
          }
        />
        <DataTable
          columns={serverColumns}
          data={filteredServers}
          emptyMessage={
            envFilter
              ? `No ${envFilter} servers for this customer.`
              : 'No servers yet. Add one to get started.'
          }
          searchPlaceholder="Search hostname or IP..."
          filters={filterSlot}
          onRowClick={(r) => navigate(`/servers/${r.id}`, { state: fromState(`/customers/${id}`, customer?.name || 'customer') })}
          mobile={{ accent: (r) => envAccent(r.environment) }}
        />
      </section>

      {/* ---- ZONE 3: DETAILS ---- */}
      <section className="space-y-3">
        <SectionHeading>Details</SectionHeading>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">

          {/* Customer Info card */}
          <SectionCard title="Customer info">
            <dl>
              <MetaRow label="Name">{customer.name}</MetaRow>
              <MetaRow label="Slug">
                <span className="font-mono text-xs">{customer.slug}</span>
              </MetaRow>
              {customer.description && (
                <MetaRow label="Description">{customer.description}</MetaRow>
              )}
              <MetaRow label="Status">
                <span
                  className={`inline-flex items-center gap-1.5 text-sm font-medium ${
                    customer.isActive ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'
                  }`}
                >
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${
                      customer.isActive ? 'bg-emerald-500' : 'bg-muted-foreground/60'
                    }`}
                  />
                  {customer.isActive ? 'Active' : 'Inactive'}
                </span>
              </MetaRow>
              <MetaRow label="Created">
                <span className="text-xs">{formatDateTime(customer.createdAt)}</span>
              </MetaRow>
              <MetaRow label="Updated">
                <span className="text-xs">{formatDateTime(customer.updatedAt)}</span>
              </MetaRow>
            </dl>
          </SectionCard>

          {/* Health Summary card */}
          <SectionCard title="Health summary">
            <div className="space-y-3">
              {[
                {
                  label: 'Healthy',
                  count: healthyCount,
                  dotClass: 'bg-emerald-500',
                  textClass: 'text-emerald-600 dark:text-emerald-400',
                },
                {
                  label: 'Unhealthy',
                  count: unhealthyCount,
                  dotClass: 'bg-red-500',
                  textClass: 'text-red-600 dark:text-red-400',
                },
                {
                  label: 'Unknown',
                  count: unknownCount,
                  dotClass: 'bg-muted-foreground/60',
                  textClass: 'text-muted-foreground',
                },
              ].map(({ label, count, dotClass, textClass }) => (
                <div key={label} className="flex items-center justify-between">
                  <span className="flex items-center gap-2 text-sm text-foreground">
                    <span className={`h-2 w-2 rounded-full ${dotClass}`} />
                    {label}
                  </span>
                  <span className={`text-sm font-semibold tabular-nums ${textClass}`}>
                    {count}
                  </span>
                </div>
              ))}

              {/* Environment breakdown */}
              {ENVIRONMENTS.some((e) => (byEnv[e] || 0) > 0) && (
                <>
                  <div className="pt-2 border-t border-border" />
                  {ENVIRONMENTS.filter((e) => (byEnv[e] || 0) > 0).map((e) => (
                    <div key={e} className="flex items-center justify-between">
                      <span className="flex items-center gap-2 text-sm text-foreground">
                        <span
                          className={`h-2 w-2 rounded-full ${ENV_DOT_COLORS[e] || 'bg-muted-foreground/60'}`}
                        />
                        <EnvironmentBadge environment={e} />
                      </span>
                      <span className="text-sm font-semibold tabular-nums text-muted-foreground">
                        {byEnv[e]}
                      </span>
                    </div>
                  ))}
                </>
              )}
            </div>
          </SectionCard>

          {/* Quick Actions card */}
          <SectionCard title="Quick Actions">
            <div className="flex flex-col gap-2">
              {canAddServer && (
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full justify-start gap-2"
                  onClick={() => setAddServerOpen(true)}
                >
                  <Plus className="h-4 w-4" />
                  Add server
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                className="w-full justify-start gap-2"
                onClick={() => navigate('/access-requests')}
              >
                <Shield className="h-4 w-4" />
                Request Server Access
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="w-full justify-start gap-2"
                onClick={() => navigate(`/servers?customerId=${id}`)}
              >
                <ExternalLink className="h-4 w-4" />
                View in Servers
              </Button>
              {canManage && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full justify-start gap-2 text-muted-foreground hover:text-foreground"
                  onClick={() => setEditOpen(true)}
                >
                  <Pencil className="h-4 w-4" />
                  Edit customer
                </Button>
              )}
            </div>
          </SectionCard>
        </div>
      </section>

      {/* ---- MODALS ---- */}

      <Modal open={editOpen} onClose={() => setEditOpen(false)} title="Edit customer">
        <CustomerForm
          customer={customer}
          onSubmit={handleEdit}
          onCancel={() => setEditOpen(false)}
        />
      </Modal>

      <Modal
        open={addServerOpen}
        onClose={() => setAddServerOpen(false)}
        title="Add server"
        size="lg"
      >
        <ServerForm
          customerId={id}
          onSubmit={handleAddServer}
          onCancel={() => setAddServerOpen(false)}
        />
      </Modal>

      <DeleteCustomerDialog
        customer={customer}
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onDeleted={() => navigate('/customers')}
      />

      {canOnboard && (
        <BulkInstallModal
          open={bulkInstallOpen}
          // Scoped to this customer's hosts, so "install collectors" from a
          // customer page never quietly reaches the rest of the fleet.
          serverIds={servers.map((sv) => sv.id)}
          onClose={() => setBulkInstallOpen(false)}
        />
      )}
      {canOnboard && (
        <BulkInstallModal
          open={!!singleInstall}
          serverIds={singleInstall ? [singleInstall.id] : []}
          preselectIds={singleInstall ? [singleInstall.id] : []}
          initialMode={singleInstall?.mode || 'posture'}
          onClose={() => setSingleInstall(null)}
          onDone={loadData}
        />
      )}
    </div>
  );
}

export default CustomerDetail;
