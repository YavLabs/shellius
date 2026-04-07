import { useState, useEffect, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
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
} from 'lucide-react';
import DataTable from '@/components/shared/DataTable';
import Modal from '@/components/shared/Modal';
import ConfirmDialog from '@/components/shared/ConfirmDialog';
import Badge from '@/components/shared/Badge';
import EnvironmentBadge from '@/components/shared/EnvironmentBadge';
import HealthStatusDot from '@/components/shared/HealthStatusDot';
import CustomerForm from '@/components/customers/CustomerForm';
import ServerForm from '@/components/servers/ServerForm';
import PageHeader from '@/components/common/PageHeader';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  getCustomer,
  updateCustomer,
  deleteCustomer,
  getCustomerStats,
} from '@/services/customerService';
import { listServers, createServer } from '@/services/serverService';
import { relativeTime } from '@/utils/time';

function StatCard({ icon: Icon, label, value, iconClass }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center gap-3">
        <div className={`flex h-9 w-9 items-center justify-center rounded-md ${iconClass}`}>
          <Icon className="h-5 w-5" />
        </div>
        <div>
          <p className="text-xs text-muted-foreground">{label}</p>
          <p className="text-xl font-semibold text-foreground">{value}</p>
        </div>
      </div>
    </div>
  );
}

function CustomerDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [customer, setCustomer] = useState(null);
  const [stats, setStats] = useState(null);
  const [servers, setServers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [editOpen, setEditOpen] = useState(false);
  const [addServerOpen, setAddServerOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const fetch = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [c, s, srv] = await Promise.all([
        getCustomer(id),
        getCustomerStats(id).catch(() => null),
        listServers({ customerId: id, page: 1, pageSize: 100 }).catch(() => ({ items: [] })),
      ]);
      setCustomer(c);
      setStats(s);
      setServers(srv.items || []);
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { fetch(); }, [fetch]);

  const handleEdit = async (payload) => {
    await updateCustomer(id, payload);
    setEditOpen(false);
    fetch();
  };

  const handleDelete = async () => {
    try {
      await deleteCustomer(id);
      navigate('/customers');
    } catch (err) {
      setError(err.response?.data?.error?.message || 'Failed to delete');
      setConfirmDelete(false);
    }
  };

  const handleAddServer = async (payload) => {
    await createServer(payload);
    setAddServerOpen(false);
    fetch();
  };

  if (loading) {
    return (
      <div className="p-6">
        <div className="h-8 w-64 animate-pulse rounded bg-muted" />
      </div>
    );
  }

  if (error || !customer) {
    return (
      <div className="p-6">
        <Button variant="ghost" onClick={() => navigate('/customers')} className="gap-1 px-0 text-muted-foreground">
          <ArrowLeft className="h-4 w-4" /> Back to customers
        </Button>
        <div className="mt-4 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error || 'Customer not found'}
        </div>
      </div>
    );
  }

  const byHealth = stats?.byHealth || {};
  const byEnv = stats?.byEnvironment || {};
  const total = stats?.total ?? customer._count?.servers ?? servers.length;

  const serverColumns = [
    {
      key: 'hostname',
      label: 'Hostname',
      sortable: true,
      render: (r) => (
        <button
          onClick={() => navigate(`/servers/${r.id}`)}
          className="font-medium text-foreground hover:text-primary"
        >
          {r.hostname}
        </button>
      ),
    },
    {
      key: 'ipAddress',
      label: 'IP',
      render: (r) => <span className="font-mono text-xs text-muted-foreground">{r.ipAddress}</span>,
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
        <span className="text-xs text-muted-foreground">{relativeTime(r.lastHealthCheckAt)}</span>
      ),
    },
    {
      key: 'actions',
      label: '',
      className: 'w-10',
      actions: [
        { label: 'View Details', icon: Eye, onClick: (r) => navigate(`/servers/${r.id}`) },
      ],
    },
  ];

  return (
    <div className="space-y-6 p-6">
      <Button variant="ghost" onClick={() => navigate('/customers')} className="gap-1 px-0 text-muted-foreground">
        <ArrowLeft className="h-4 w-4" /> Back to customers
      </Button>

      <PageHeader icon={Building2} title={customer.name} subtitle={customer.slug}>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="icon" className="h-9 w-9">
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-40">
            <DropdownMenuItem onClick={() => setEditOpen(true)}>
              <Pencil className="mr-2 h-4 w-4" /> Edit
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => setConfirmDelete(true)}
              className="text-destructive focus:text-destructive"
            >
              <Trash2 className="mr-2 h-4 w-4" /> Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </PageHeader>

      {customer.description && (
        <p className="max-w-2xl text-sm text-muted-foreground">{customer.description}</p>
      )}

      <div className="flex items-center gap-2">
        <Badge variant={customer.isActive ? 'success' : 'default'}>
          {customer.isActive ? 'Active' : 'Inactive'}
        </Badge>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard icon={Server} label="Total servers" value={total} iconClass="bg-primary/10 text-primary" />
        <StatCard icon={CheckCircle} label="Healthy" value={byHealth.healthy || 0} iconClass="bg-emerald-500/10 text-emerald-500" />
        <StatCard icon={XCircle} label="Unhealthy" value={byHealth.unhealthy || 0} iconClass="bg-red-500/10 text-red-500" />
        <StatCard icon={HelpCircle} label="Unknown" value={byHealth.unknown || 0} iconClass="bg-zinc-500/10 text-zinc-500" />
      </div>

      <div className="rounded-lg border border-border bg-card p-4">
        <h3 className="text-sm font-semibold text-foreground">Environment Breakdown</h3>
        <div className="mt-3 flex flex-wrap gap-3">
          {['demo', 'dev', 'staging', 'prod'].map((env) => (
            <div key={env} className="flex items-center gap-2">
              <EnvironmentBadge environment={env} />
              <span className="text-sm text-foreground">{byEnv[env] || 0}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="rounded-lg border border-border bg-card">
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <h3 className="text-sm font-semibold text-foreground">Servers ({servers.length})</h3>
          <Button size="sm" onClick={() => setAddServerOpen(true)}>
            <Plus className="mr-1.5 h-3.5 w-3.5" /> Add Server
          </Button>
        </div>
        <DataTable
          columns={serverColumns}
          data={servers}
          emptyMessage="No servers for this customer"
          searchPlaceholder="Search servers..."
          onRowClick={(r) => navigate(`/servers/${r.id}`)}
        />
      </div>

      <Modal open={editOpen} onClose={() => setEditOpen(false)} title="Edit Customer">
        <CustomerForm customer={customer} onSubmit={handleEdit} onCancel={() => setEditOpen(false)} />
      </Modal>

      <Modal open={addServerOpen} onClose={() => setAddServerOpen(false)} title="Add Server" size="lg">
        <ServerForm customerId={id} onSubmit={handleAddServer} onCancel={() => setAddServerOpen(false)} />
      </Modal>

      <ConfirmDialog
        open={confirmDelete}
        title="Delete customer"
        message={`Permanently delete "${customer.name}"? This cannot be undone.`}
        confirmLabel="Delete"
        variant="destructive"
        onConfirm={handleDelete}
        onCancel={() => setConfirmDelete(false)}
      />
    </div>
  );
}

export default CustomerDetail;
