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
} from 'lucide-react';
import DataTable from '@/components/shared/DataTable';
import Modal from '@/components/shared/Modal';
import ConfirmDialog from '@/components/shared/ConfirmDialog';
import EnvironmentBadge from '@/components/shared/EnvironmentBadge';
import HealthStatusDot from '@/components/shared/HealthStatusDot';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
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

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function StatTile({ icon: Icon, label, value, iconClass, loading }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-card p-4">
      <div
        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-md ${iconClass}`}
      >
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0">
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {label}
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
  demo: 'bg-zinc-400',
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

  const loadData = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [c, s, srv, sessions] = await Promise.all([
        getCustomer(id),
        getCustomerStats(id).catch(() => null),
        listServers({ customerId: id, page: 1, pageSize: 200 }).catch(() => ({ items: [] })),
        listSessions({ customerId: id, status: 'ACTIVE', page: 1, pageSize: 1 }).catch(() => null),
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
      .map((s) => s.lastHealthCheckAt)
      .filter(Boolean)
      .map((d) => new Date(d).getTime())
      .filter((t) => !isNaN(t));
    return dates.length ? Math.max(...dates) : null;
  }, [servers]);

  // Env breakdown string — "prod 3 · staging 2 · dev 5"
  const envSummary = useMemo(() => {
    const parts = ENVIRONMENTS.filter((e) => (byEnv[e] || 0) > 0).map(
      (e) => `${e} ${byEnv[e]}`
    );
    return parts.join(' · ') || 'No servers';
  }, [byEnv]);

  // Filtered servers for table
  const filteredServers = useMemo(() => {
    if (!envFilter) return servers;
    return servers.filter((s) => s.environment === envFilter);
  }, [servers, envFilter]);

  // Server table columns
  const serverColumns = [
    {
      key: 'hostname',
      label: 'Hostname',
      sortable: true,
      searchAccessor: (r) => `${r.hostname} ${r.ipAddress || ''}`,
      render: (r) => {
        const proto = r.protocol || r.type || 'SSH';
        const ProtoIcon = proto === 'RDP' ? Monitor : TerminalIcon;
        return (
          <button
            onClick={() => navigate(`/servers/${r.id}`)}
            className="flex items-center gap-2 font-medium text-foreground hover:text-primary"
          >
            <ProtoIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            {r.hostname}
          </button>
        );
      },
    },
    {
      key: 'ipAddress',
      label: 'IP',
      render: (r) => (
        <span className="font-mono text-xs text-muted-foreground">{r.ipAddress || '-'}</span>
      ),
    },
    {
      key: 'protocol',
      label: 'Proto',
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
      render: (r) => <EnvironmentBadge environment={r.environment} />,
    },
    {
      key: 'health',
      label: 'Health',
      searchAccessor: (r) => r.healthStatus || '',
      render: (r) => <HealthStatusDot status={r.healthStatus} showLabel />,
    },
    {
      key: 'lastCheck',
      label: 'Last Check',
      hideBelow: 'md',
      render: (r) => (
        <span className="text-xs text-muted-foreground">
          {relativeTime(r.lastHealthCheckAt)}
        </span>
      ),
    },
    {
      key: 'actions',
      label: '',
      className: 'w-10',
      actions: [
        {
          label: 'View Details',
          icon: Eye,
          onClick: (r) => navigate(`/servers/${r.id}`),
        },
      ],
    },
  ];

  // Environment filter slot for DataTable
  const filterSlot = (
    <Select
      value={envFilter || '_all'}
      onValueChange={(v) => setEnvFilter(v === '_all' ? '' : v)}
    >
      <SelectTrigger className="w-[160px]">
        <SelectValue placeholder="All environments" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="_all">All environments</SelectItem>
        {ENVIRONMENTS.map((e) => (
          <SelectItem key={e} value={e}>
            {e}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  // ---------------------------------------------------------------------------
  // Loading state
  // ---------------------------------------------------------------------------
  if (loading) {
    return (
      <div className="space-y-6 p-6">
        <HeroSkeleton />
        {/* table skeleton */}
        <div className="rounded-lg border border-border bg-card">
          <div className="border-b border-border px-5 py-3">
            <Skeleton className="h-4 w-24" />
          </div>
          <div className="p-4">
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
      <div className="space-y-4 p-6">
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
    <div className="space-y-6 p-6">

      {/* ---- ZONE 1: HERO ---- */}

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
            <div>
              <h1 className="text-2xl font-bold tracking-tight text-foreground">
                {customer.name}
              </h1>
              <p className="text-sm text-muted-foreground">
                <span className="font-mono">{customer.slug}</span>
                {envSummary && envSummary !== 'No servers' && (
                  <span className="ml-2 text-muted-foreground/60">&mdash; {envSummary}</span>
                )}
              </p>
            </div>
          </div>
          {customer.description && (
            <p className="max-w-2xl text-sm text-muted-foreground pl-[3.25rem]">
              {customer.description}
            </p>
          )}
        </div>

        {/* Action group */}
        <div className="flex shrink-0 items-center gap-2">
          <Button size="sm" onClick={() => setAddServerOpen(true)}>
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            Add Server
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="icon" className="h-9 w-9">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem onClick={() => setEditOpen(true)}>
                <Pencil className="mr-2 h-4 w-4" />
                Edit Customer
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => setConfirmDelete(true)}
                className="text-destructive focus:text-destructive"
              >
                <Trash2 className="mr-2 h-4 w-4" />
                Delete Customer
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Stat tiles */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile
          icon={Server}
          label="Total Servers"
          value={total}
          iconClass="bg-primary/10 text-primary"
        />
        <StatTile
          icon={Activity}
          label="Active Sessions"
          value={activeSessions}
          iconClass="bg-emerald-500/10 text-emerald-500"
        />
        <StatTile
          icon={CheckCircle}
          label="Healthy"
          value={healthyCount}
          iconClass="bg-emerald-500/10 text-emerald-500"
        />
        <StatTile
          icon={Clock}
          label="Last Health Check"
          value={lastHealthCheck ? relativeTime(new Date(lastHealthCheck)) : 'Never'}
          iconClass="bg-zinc-500/10 text-zinc-500"
        />
      </div>

      {/* ---- ZONE 2: TWO-COLUMN MAIN CONTENT ---- */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">

        {/* LEFT: servers table (2/3) */}
        <div className="lg:col-span-2">
          <div className="rounded-lg border border-border bg-card overflow-hidden">
            <div className="flex items-center justify-between border-b border-border px-5 py-3">
              <h3 className="text-sm font-semibold text-foreground">
                Servers
                <span className="ml-2 text-muted-foreground font-normal">
                  ({filteredServers.length}{envFilter ? ` of ${servers.length}` : ''})
                </span>
              </h3>
              <Button size="sm" variant="outline" onClick={() => setAddServerOpen(true)}>
                <Plus className="mr-1.5 h-3.5 w-3.5" />
                Add Server
              </Button>
            </div>
            {/* Padding around the DataTable so the inner content (search,
                filters, rows, pagination) never butts up against the card
                borders. */}
            <div className="p-4">
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
                onRowClick={(r) => navigate(`/servers/${r.id}`)}
              />
            </div>
          </div>
        </div>

        {/* RIGHT: info sidebar (1/3) */}
        <div className="flex flex-col gap-5">

          {/* Customer Info card */}
          <SectionCard title="Customer Info">
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
                      customer.isActive ? 'bg-emerald-500' : 'bg-zinc-400'
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
          <SectionCard title="Health Summary">
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
                  dotClass: 'bg-zinc-400',
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
                          className={`h-2 w-2 rounded-full ${ENV_DOT_COLORS[e] || 'bg-zinc-400'}`}
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
              <Button
                variant="outline"
                size="sm"
                className="w-full justify-start gap-2"
                onClick={() => setAddServerOpen(true)}
              >
                <Plus className="h-4 w-4" />
                Add Server
              </Button>
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
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-start gap-2 text-muted-foreground hover:text-foreground"
                onClick={() => setEditOpen(true)}
              >
                <Pencil className="h-4 w-4" />
                Edit Customer
              </Button>
            </div>
          </SectionCard>

        </div>
      </div>

      {/* ---- MODALS ---- */}

      <Modal open={editOpen} onClose={() => setEditOpen(false)} title="Edit Customer">
        <CustomerForm
          customer={customer}
          onSubmit={handleEdit}
          onCancel={() => setEditOpen(false)}
        />
      </Modal>

      <Modal
        open={addServerOpen}
        onClose={() => setAddServerOpen(false)}
        title="Add Server"
        size="lg"
      >
        <ServerForm
          customerId={id}
          onSubmit={handleAddServer}
          onCancel={() => setAddServerOpen(false)}
        />
      </Modal>

      <ConfirmDialog
        open={confirmDelete}
        title="Delete customer"
        message={`Permanently delete "${customer.name}"? All associated servers and their audit history will be affected. This cannot be undone.`}
        confirmLabel="Delete"
        variant="destructive"
        onConfirm={handleDelete}
        onCancel={() => setConfirmDelete(false)}
      />
    </div>
  );
}

export default CustomerDetail;
