import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Plus,
  MoreVertical,
  Pencil,
  Trash2,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import DataTable from '@/components/shared/DataTable';
import SearchInput from '@/components/shared/SearchInput';
import ConfirmDialog from '@/components/shared/ConfirmDialog';
import EnvironmentBadge from '@/components/shared/EnvironmentBadge';
import Badge from '@/components/shared/Badge';
import PolicyForm from '@/components/policies/PolicyForm';
import { listPolicies, createPolicy, updatePolicy, deletePolicy } from '@/services/policyService';
import { listCustomers } from '@/services/customerService';
import { useAuth } from '@/context/AuthContext';
import { relativeTime } from '@/utils/time';

const ROLE_RANK = { super_admin: 4, admin: 3, operator: 2, viewer: 1 };
function isAtLeast(user, role) {
  return (ROLE_RANK[user?.role] || 0) >= (ROLE_RANK[role] || 0);
}

function EffectBadge({ effect }) {
  if (effect === 'ALLOW') {
    return <Badge variant="success">ALLOW</Badge>;
  }
  return <Badge variant="danger">DENY</Badge>;
}

function RowMenu({ onEdit, onDelete }) {
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
        <div className="absolute right-0 z-20 mt-1 w-44 overflow-hidden rounded-md border border-border bg-card shadow-lg">
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

function Policies() {
  const { user } = useAuth();
  const canAdmin = isAtLeast(user, 'admin');

  const [policies, setPolicies] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(20);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [search, setSearch] = useState('');
  const [effectFilter, setEffectFilter] = useState('');
  const [customerFilter, setCustomerFilter] = useState('');
  const [activeFilter, setActiveFilter] = useState('');
  const [customers, setCustomers] = useState([]);

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [confirm, setConfirm] = useState(null);

  const fetchCustomers = useCallback(async () => {
    try {
      const d = await listCustomers({ page: 1, pageSize: 200 });
      setCustomers(d.items || []);
    } catch {
      /* ignore */
    }
  }, []);

  const fetchPolicies = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = { page, limit: pageSize };
      if (effectFilter) params.effect = effectFilter;
      if (customerFilter) params.customerId = customerFilter;
      if (activeFilter !== '') params.isActive = activeFilter === 'true';
      const resp = await listPolicies(params);
      const items = resp.data?.items || resp.data || [];
      const metaTotal = resp.meta?.total ?? resp.data?.total ?? items.length;
      const filtered = search
        ? items.filter((p) =>
            (p.name || '').toLowerCase().includes(search.toLowerCase())
          )
        : items;
      setPolicies(filtered);
      setTotal(metaTotal);
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message || 'Failed to load policies');
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, effectFilter, customerFilter, activeFilter, search]);

  useEffect(() => {
    fetchCustomers();
  }, [fetchCustomers]);

  useEffect(() => {
    fetchPolicies();
  }, [fetchPolicies]);

  const handleSubmit = async (payload) => {
    if (editing) {
      await updatePolicy(editing.id, payload);
    } else {
      await createPolicy(payload);
    }
    setFormOpen(false);
    setEditing(null);
    fetchPolicies();
  };

  const handleDelete = (policy) => {
    setConfirm({
      title: 'Delete Policy',
      message: `Permanently delete "${policy.name}"? This cannot be undone and may affect users who rely on this policy for access.`,
      variant: 'destructive',
      confirmLabel: 'Delete',
      onConfirm: async () => {
        try {
          await deletePolicy(policy.id);
        } catch (err) {
          setError(err.response?.data?.error?.message || 'Failed to delete policy');
        }
        setConfirm(null);
        fetchPolicies();
      },
    });
  };

  const customerMap = Object.fromEntries(customers.map((c) => [c.id, c.name]));

  const columns = [
    {
      key: 'name',
      label: 'Name',
      render: (r) => (
        <div>
          <p className="text-sm font-medium text-foreground">{r.name}</p>
          {r.description && (
            <p className="text-xs text-muted-foreground truncate max-w-xs">{r.description}</p>
          )}
        </div>
      ),
    },
    {
      key: 'effect',
      label: 'Effect',
      render: (r) => <EffectBadge effect={r.effect} />,
    },
    {
      key: 'scope',
      label: 'Scope',
      render: (r) => (
        <span className="text-sm text-muted-foreground">
          {r.customerId ? customerMap[r.customerId] || r.customerId : 'Org-wide'}
        </span>
      ),
    },
    {
      key: 'environments',
      label: 'Environments',
      render: (r) => {
        const envs = r.targetEnvironments || [];
        if (envs.length === 0)
          return <span className="text-xs text-muted-foreground">All</span>;
        return (
          <div className="flex flex-wrap gap-1">
            {envs.map((e) => (
              <EnvironmentBadge key={e} environment={e} />
            ))}
          </div>
        );
      },
    },
    {
      key: 'subjects',
      label: 'Subjects',
      render: (r) => {
        const count = (r.subjects || []).length;
        return (
          <span className="text-sm text-muted-foreground">
            {count} subject{count === 1 ? '' : 's'}
          </span>
        );
      },
    },
    {
      key: 'priority',
      label: 'Priority',
      render: (r) => (
        <span className="font-mono text-xs text-muted-foreground">{r.priority ?? 0}</span>
      ),
    },
    {
      key: 'isActive',
      label: 'Status',
      render: (r) =>
        r.isActive ? (
          <Badge variant="success">Active</Badge>
        ) : (
          <Badge variant="default">Inactive</Badge>
        ),
    },
    {
      key: 'updatedAt',
      label: 'Updated',
      render: (r) => (
        <span className="text-xs text-muted-foreground">{relativeTime(r.updatedAt)}</span>
      ),
    },
    ...(canAdmin
      ? [
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
                onDelete={() => handleDelete(r)}
              />
            ),
          },
        ]
      : []),
  ];

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const selectCls =
    'h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring';

  return (
    <div className="space-y-5 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Policies</h1>
          <p className="text-sm text-muted-foreground">
            Access control policies governing who can reach which servers.
          </p>
        </div>
        {canAdmin && (
          <button
            onClick={() => {
              setEditing(null);
              setFormOpen(true);
            }}
            className="flex h-9 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            <Plus className="h-4 w-4" /> New Policy
          </button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-56 flex-1">
          <SearchInput
            value={search}
            onChange={(v) => {
              setSearch(v);
              setPage(1);
            }}
            placeholder="Search by policy name..."
          />
        </div>
        <select
          className={selectCls}
          value={effectFilter}
          onChange={(e) => {
            setEffectFilter(e.target.value);
            setPage(1);
          }}
        >
          <option value="">All effects</option>
          <option value="ALLOW">ALLOW</option>
          <option value="DENY">DENY</option>
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
        <select
          className={selectCls}
          value={activeFilter}
          onChange={(e) => {
            setActiveFilter(e.target.value);
            setPage(1);
          }}
        >
          <option value="">All statuses</option>
          <option value="true">Active</option>
          <option value="false">Inactive</option>
        </select>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <DataTable
        columns={columns}
        data={policies}
        loading={loading}
        emptyMessage="No policies found. Create one to control server access."
      />

      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {total} polic{total === 1 ? 'y' : 'ies'}
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

      <PolicyForm
        open={formOpen}
        onClose={() => {
          setFormOpen(false);
          setEditing(null);
        }}
        onSubmit={handleSubmit}
        policy={editing}
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

export default Policies;
