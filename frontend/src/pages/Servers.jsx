import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Plus,
  MoreVertical,
  Pencil,
  Trash2,
  Activity,
  ChevronLeft,
  ChevronRight,
  X,
} from 'lucide-react';
import DataTable from '@/components/shared/DataTable';
import SearchInput from '@/components/shared/SearchInput';
import Modal from '@/components/shared/Modal';
import ConfirmDialog from '@/components/shared/ConfirmDialog';
import EnvironmentBadge from '@/components/shared/EnvironmentBadge';
import HealthStatusDot from '@/components/shared/HealthStatusDot';
import ServerForm from '@/components/servers/ServerForm';
import {
  listServers,
  createServer,
  updateServer,
  deleteServer,
  bulkUpdateEnvironment,
  triggerHealthCheck,
} from '@/services/serverService';
import { listCustomers } from '@/services/customerService';
import { relativeTime } from '@/utils/time';

const ENVIRONMENTS = ['demo', 'dev', 'staging', 'prod'];
const HEALTH_STATUSES = ['healthy', 'unhealthy', 'unknown', 'maintenance'];

function RowMenu({ onEdit, onHealthCheck, onDelete }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const fn = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    window.addEventListener('mousedown', fn);
    return () => window.removeEventListener('mousedown', fn);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={(e) => {
          e.stopPropagation();
          setOpen((p) => !p);
        }}
        className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <MoreVertical className="h-4 w-4" />
      </button>
      {open && (
        <div className="absolute right-0 z-20 mt-1 w-48 overflow-hidden rounded-md border border-border bg-card shadow-lg">
          <button
            onClick={(e) => {
              e.stopPropagation();
              setOpen(false);
              onEdit();
            }}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-foreground hover:bg-accent"
          >
            <Pencil className="h-3.5 w-3.5" /> Edit
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              setOpen(false);
              onHealthCheck();
            }}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-foreground hover:bg-accent"
          >
            <Activity className="h-3.5 w-3.5" /> Run Health Check
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              setOpen(false);
              onDelete();
            }}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-destructive hover:bg-accent"
          >
            <Trash2 className="h-3.5 w-3.5" /> Delete
          </button>
        </div>
      )}
    </div>
  );
}

function Servers() {
  const navigate = useNavigate();
  const [servers, setServers] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(20);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [search, setSearch] = useState('');
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
      if (search) params.search = search;
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
  }, [page, pageSize, search, environment, healthStatus, customerFilter]);

  useEffect(() => {
    fetchCustomers();
  }, [fetchCustomers]);

  useEffect(() => {
    fetch();
  }, [fetch]);

  const toggleSelect = (id) => {
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

  const toggleSelectAll = () => {
    if (selected.length === servers.length) {
      setSelected([]);
    } else {
      setSelected(servers.map((s) => s.id));
    }
  };

  const handleSubmit = async (payload) => {
    if (editing) {
      await updateServer(editing.id, payload);
    } else {
      await createServer(payload);
    }
    setFormOpen(false);
    setEditing(null);
    fetch();
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

  const columns = [
    {
      key: 'select',
      label: (
        <input
          type="checkbox"
          checked={servers.length > 0 && selected.length === servers.length}
          onChange={toggleSelectAll}
        />
      ),
      className: 'w-10',
      render: (r) => (
        <input
          type="checkbox"
          checked={selected.includes(r.id)}
          onChange={(e) => {
            e.stopPropagation();
            toggleSelect(r.id);
          }}
          onClick={(e) => e.stopPropagation()}
        />
      ),
    },
    {
      key: 'hostname',
      label: 'Hostname',
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
      key: 'customer',
      label: 'Customer',
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
      render: (r) => <EnvironmentBadge environment={r.environment} />,
    },
    {
      key: 'protocol',
      label: 'Protocol',
      render: (r) => (
        <span className="text-xs uppercase text-muted-foreground">{r.protocol}</span>
      ),
    },
    {
      key: 'health',
      label: 'Health',
      render: (r) => <HealthStatusDot status={r.healthStatus} showLabel />,
    },
    {
      key: 'os',
      label: 'OS',
      render: (r) => <span className="text-muted-foreground">{r.osType || '-'}</span>,
    },
    {
      key: 'lastCheck',
      label: 'Last Check',
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
      render: (r) => (
        <RowMenu
          onEdit={() => {
            setEditing(r);
            setFormOpen(true);
          }}
          onHealthCheck={() => handleHealthCheck(r)}
          onDelete={() => handleDelete(r)}
        />
      ),
    },
  ];

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const selectCls =
    'h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring';

  return (
    <div className="space-y-5 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Servers</h1>
          <p className="text-sm text-muted-foreground">
            Manage target servers across customers.
          </p>
        </div>
        <button
          onClick={() => {
            setEditing(null);
            setFormOpen(true);
          }}
          className="flex h-9 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          <Plus className="h-4 w-4" /> Add Server
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-64 flex-1">
          <SearchInput
            value={search}
            onChange={(v) => {
              setSearch(v);
              setPage(1);
            }}
            placeholder="Search hostname or IP..."
          />
        </div>
        <select
          className={selectCls}
          value={environment}
          onChange={(e) => {
            setEnvironment(e.target.value);
            setPage(1);
          }}
        >
          <option value="">All environments</option>
          {ENVIRONMENTS.map((e) => (
            <option key={e} value={e}>
              {e}
            </option>
          ))}
        </select>
        <select
          className={selectCls}
          value={healthStatus}
          onChange={(e) => {
            setHealthStatus(e.target.value);
            setPage(1);
          }}
        >
          <option value="">All health</option>
          {HEALTH_STATUSES.map((h) => (
            <option key={h} value={h}>
              {h}
            </option>
          ))}
        </select>
        <select
          className={selectCls}
          value={customerFilter}
          onChange={(e) => {
            setCustomerFilter(e.target.value);
            setPage(1);
          }}
        >
          <option value="">All customers</option>
          {customers.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>

      {selected.length > 0 && (
        <div className="flex items-center justify-between rounded-lg border border-border bg-accent/30 px-4 py-2.5">
          <span className="text-sm text-foreground">
            {selected.length} selected
          </span>
          <div className="flex items-center gap-2">
            <select
              className={selectCls}
              value={bulkEnv}
              onChange={(e) => setBulkEnv(e.target.value)}
            >
              <option value="">Change environment...</option>
              {ENVIRONMENTS.map((e) => (
                <option key={e} value={e}>
                  {e}
                </option>
              ))}
            </select>
            <button
              onClick={() => bulkEnv && setBulkConfirm(true)}
              disabled={!bulkEnv}
              className="h-9 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              Apply
            </button>
            <button
              onClick={() => setSelected([])}
              className="flex h-9 items-center gap-1 rounded-md border border-input bg-background px-3 text-sm font-medium text-foreground hover:bg-accent"
            >
              <X className="h-4 w-4" /> Clear
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <DataTable columns={columns} data={servers} loading={loading} emptyMessage="No servers found" />

      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {total} server{total === 1 ? '' : 's'}
        </p>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1}
            className="flex h-8 items-center gap-1 rounded-md border border-input bg-background px-3 text-sm text-foreground hover:bg-accent disabled:opacity-50"
          >
            <ChevronLeft className="h-4 w-4" /> Previous
          </button>
          <span className="text-sm text-muted-foreground">
            Page {page} of {totalPages}
          </span>
          <button
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page >= totalPages}
            className="flex h-8 items-center gap-1 rounded-md border border-input bg-background px-3 text-sm text-foreground hover:bg-accent disabled:opacity-50"
          >
            Next <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </div>

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
