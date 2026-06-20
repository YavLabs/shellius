import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Plus,
  Pencil,
  Trash2,
  Activity,
  X,
  Server as ServerIcon,
  Terminal as TerminalIcon,
  Monitor,
  Download,
  Eye,
  Eraser,
} from 'lucide-react';
import DataTable from '@/components/shared/DataTable';
import Modal from '@/components/shared/Modal';
import ConfirmDialog from '@/components/shared/ConfirmDialog';
import EnvironmentBadge from '@/components/shared/EnvironmentBadge';
import HealthStatusDot from '@/components/shared/HealthStatusDot';
import ServerForm from '@/components/servers/ServerForm';
import BootstrapModal from '@/components/servers/BootstrapModal';
import UninstallHostModal from '@/components/servers/UninstallHostModal';
import QuickConnectButton from '@/components/servers/QuickConnectButton';
import PageHeader from '@/components/common/PageHeader';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  listServers,
  createServer,
  updateServer,
  deleteServer,
  bulkUpdateEnvironment,
  triggerHealthCheck,
} from '@/services/serverService';
import { listCustomers } from '@/services/customerService';
import { useAuth } from '@/context/AuthContext';
import { relativeTime } from '@/utils/time';

const ENVIRONMENTS = ['demo', 'dev', 'staging', 'prod'];
const HEALTH_STATUSES = ['healthy', 'unhealthy', 'unknown', 'maintenance'];

function Servers() {
  const navigate = useNavigate();
  const { user } = useAuth();
  // Create / edit / delete / bootstrap are admin-only (matches the API).
  const canManage = user?.role === 'super_admin' || user?.role === 'admin';

  const [servers, setServers] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [environment, setEnvironment] = useState('');
  const [healthStatus, setHealthStatus] = useState('');
  const [customerFilter, setCustomerFilter] = useState('');
  const [customers, setCustomers] = useState([]);

  const [selected, setSelected] = useState([]);
  const [bulkEnv, setBulkEnv] = useState('');
  const [bulkConfirm, setBulkConfirm] = useState(false);

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [bootstrapServer, setBootstrapServer] = useState(null);
  const [uninstallServer, setUninstallServer] = useState(null);

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
      const params = { page, pageSize };
      if (environment) params.environment = environment;
      if (healthStatus) params.healthStatus = healthStatus;
      if (customerFilter) params.customerId = customerFilter;
      const data = await listServers(params);
      setServers(data.items || []);
      setTotal(data.total || 0);
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message || 'Failed to load servers');
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, environment, healthStatus, customerFilter]);

  useEffect(() => {
    fetchCustomers();
  }, [fetchCustomers]);

  useEffect(() => {
    fetch();
  }, [fetch]);

  const handleSubmit = async (payload) => {
    let created = null;
    if (editing) {
      await updateServer(editing.id, payload);
    } else {
      const resp = await createServer(payload);
      created = resp?.server || resp;
    }
    setFormOpen(false);
    setEditing(null);
    fetch();
    if (created?.id) {
      setBootstrapServer(created);
    }
  };

  const handleDelete = (server) => {
    setConfirm({
      title: 'Delete server',
      message: `Permanently delete ${server.hostname}? This cannot be undone.`,
      variant: 'destructive',
      confirmLabel: 'Delete',
      onConfirm: async () => {
        await deleteServer(server.id);
        setConfirm(null);
        fetch();
      },
    });
  };

  const handleHealthCheck = async (server) => {
    try {
      await triggerHealthCheck(server.id);
      fetch();
    } catch (err) {
      setError(err.response?.data?.error?.message || 'Health check failed');
    }
  };

  const handleBulkUpdate = async () => {
    await bulkUpdateEnvironment(selected, bulkEnv);
    setBulkConfirm(false);
    setBulkEnv('');
    setSelected([]);
    fetch();
  };

  const filterSlot = (
    <>
      <Select
        value={environment || '_all'}
        onValueChange={(v) => {
          setEnvironment(v === '_all' ? '' : v);
          setPage(1);
        }}
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
      <Select
        value={healthStatus || '_all'}
        onValueChange={(v) => {
          setHealthStatus(v === '_all' ? '' : v);
          setPage(1);
        }}
      >
        <SelectTrigger className="w-[150px]">
          <SelectValue placeholder="All health" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="_all">All health</SelectItem>
          {HEALTH_STATUSES.map((h) => (
            <SelectItem key={h} value={h}>
              {h}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        value={customerFilter || '_all'}
        onValueChange={(v) => {
          setCustomerFilter(v === '_all' ? '' : v);
          setPage(1);
        }}
      >
        <SelectTrigger className="w-[180px]">
          <SelectValue placeholder="All customers" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="_all">All customers</SelectItem>
          {customers.map((c) => (
            <SelectItem key={c.id} value={c.id}>
              {c.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </>
  );

  const bulkActionsSlot =
    selected.length > 0 ? (
      <div className="flex flex-col gap-2 rounded-lg border border-border bg-accent/30 px-4 py-2.5 sm:flex-row sm:items-center sm:justify-between">
        <span className="text-sm text-foreground">{selected.length} selected</span>
        <div className="flex items-center gap-2">
          <Select value={bulkEnv} onValueChange={setBulkEnv}>
            <SelectTrigger className="w-[180px]">
              <SelectValue placeholder="Change environment..." />
            </SelectTrigger>
            <SelectContent>
              {ENVIRONMENTS.map((e) => (
                <SelectItem key={e} value={e}>
                  {e}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button size="sm" onClick={() => bulkEnv && setBulkConfirm(true)} disabled={!bulkEnv}>
            Apply
          </Button>
          <Button variant="outline" size="sm" onClick={() => setSelected([])}>
            <X className="mr-1 h-4 w-4" /> Clear
          </Button>
        </div>
      </div>
    ) : null;

  const columns = [
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
      sortable: true,
      render: (r) => <span className="font-mono text-xs text-muted-foreground">{r.ipAddress}</span>,
    },
    {
      key: 'customer',
      label: 'Customer',
      sortable: true,
      searchAccessor: (r) => r.customer?.name || '',
      render: (r) =>
        r.customer ? (
          <button
            onClick={() => navigate(`/customers/${r.customer.id}`)}
            className="text-muted-foreground hover:text-primary"
          >
            {r.customer.name}
          </button>
        ) : (
          <span className="text-muted-foreground">-</span>
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
      key: 'protocol',
      label: 'Protocol',
      sortable: true,
      render: (r) => (
        <span className="text-xs uppercase text-muted-foreground">{r.protocol}</span>
      ),
    },
    {
      key: 'health',
      label: 'Health',
      searchAccessor: (r) => r.healthStatus || '',
      render: (r) => <HealthStatusDot status={r.healthStatus} showLabel />,
    },
    {
      key: 'os',
      label: 'OS',
      hideBelow: 'lg',
      render: (r) => <span className="text-muted-foreground">{r.osType || '-'}</span>,
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
      key: 'quickConnect',
      label: '',
      className: 'w-36',
      render: (r) => <QuickConnectButton server={r} currentUser={user} />,
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
        ...(canManage
          ? [
              {
                label: 'Edit',
                icon: Pencil,
                onClick: (r) => {
                  setEditing(r);
                  setFormOpen(true);
                },
              },
              {
                label: 'Bootstrap Host',
                icon: Download,
                onClick: (r) => setBootstrapServer(r),
              },
              {
                label: 'Uninstall Agent',
                icon: Eraser,
                onClick: (r) => setUninstallServer(r),
              },
              {
                label: 'Run Health Check',
                icon: Activity,
                onClick: (r) => handleHealthCheck(r),
              },
              { separator: true },
              {
                label: 'Delete',
                icon: Trash2,
                variant: 'destructive',
                onClick: (r) => handleDelete(r),
              },
            ]
          : []),
      ],
    },
  ];

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        icon={ServerIcon}
        title="Servers"
        subtitle="Manage target servers across customers." helpKey="servers">
        {canManage && (
          <Button
            onClick={() => {
              setEditing(null);
              setFormOpen(true);
            }}
          >
            <Plus className="mr-2 h-4 w-4" /> Add Server
          </Button>
        )}
      </PageHeader>

      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <DataTable
        columns={columns}
        data={servers}
        loading={loading}
        emptyMessage="No servers found"
        searchPlaceholder="Search hostname or IP..."
        filters={filterSlot}
        selectable
        selectedIds={selected}
        onSelectionChange={setSelected}
        bulkActions={bulkActionsSlot}
        onRowClick={(r) => navigate(`/servers/${r.id}`)}
        serverPagination={{
          page,
          total,
          onPageChange: setPage,
          pageSize,
          onPageSizeChange: (size) => { setPageSize(size); setPage(1); },
        }}
      />

      <Modal
        open={formOpen}
        onClose={() => {
          setFormOpen(false);
          setEditing(null);
        }}
        title={editing ? 'Edit Server' : 'Add Server'}
        size="lg"
      >
        <ServerForm
          server={editing}
          onSubmit={handleSubmit}
          onCancel={() => {
            setFormOpen(false);
            setEditing(null);
          }}
        />
      </Modal>

      <BootstrapModal
        open={!!bootstrapServer}
        server={bootstrapServer}
        onClose={() => setBootstrapServer(null)}
      />

      <UninstallHostModal
        open={!!uninstallServer}
        server={uninstallServer}
        onClose={() => setUninstallServer(null)}
      />

      <ConfirmDialog
        open={bulkConfirm}
        title="Change environment"
        message={`Change environment to "${bulkEnv}" for ${selected.length} server(s)?`}
        confirmLabel="Apply"
        onConfirm={handleBulkUpdate}
        onCancel={() => setBulkConfirm(false)}
      />

      <ConfirmDialog
        open={!!confirm}
        title={confirm?.title}
        message={confirm?.message}
        confirmLabel={confirm?.confirmLabel}
        variant={confirm?.variant}
        onConfirm={confirm?.onConfirm}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
}

export default Servers;
