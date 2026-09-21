import { useState, useEffect, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Plus, Building2, Server, Eye, Pencil, Trash2 } from 'lucide-react';
import Badge from '@/components/shared/Badge';
import Modal from '@/components/shared/Modal';
import ConfirmDialog from '@/components/shared/ConfirmDialog';
import DataTable from '@/components/shared/DataTable';
import FilteredEmptyState from '@/components/shared/FilteredEmptyState';
import { appliedFilterCount, clearedFilterValues } from '@/lib/filters';
import { CardIcon } from '@/components/mobile/MobileCard';
import CustomerForm from '@/components/customers/CustomerForm';
import PageHeader from '@/components/common/PageHeader';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/context/AuthContext';
import { can } from '@/lib/permissions';
import { listCustomers, createCustomer, updateCustomer } from '@/services/customerService';
import DeleteCustomerDialog from '@/components/customers/DeleteCustomerDialog';
import useAutoRefresh from '@/hooks/useAutoRefresh';
import useUrlFilters from '@/hooks/useUrlFilters';

// Column key -> backend sortBy for listCustomers.
const SORT_KEY_TO_BACKEND = {
  name: 'name',
  slug: 'slug',
  servers: 'servers',
  status: 'status',
};

function Customers() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const canCreate = can(user, 'customers.create');
  const canManage = can(user, 'customers.update');
  const canDelete = can(user, 'customers.delete');
  const [customers, setCustomers] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [searchParams, setSearchParams] = useSearchParams();

  const [f, setF] = useUrlFilters({
    q: '',
    status: '',
    hasServers: '',
    sortBy: '',
    sortDir: 'asc',
    page: '1',
    pageSize: '20',
  });
  const page = parseInt(f.page, 10) || 1;
  const pageSize = parseInt(f.pageSize, 10) || 20;

  // Deep link: /customers?action=new — open the create modal on mount.
  useEffect(() => {
    if (searchParams.get('action') === 'new' && canCreate) {
      setCreateOpen(true);
      const next = new URLSearchParams(searchParams);
      next.delete('action');
      setSearchParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetch = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = { page, pageSize };
      if (f.q) params.search = f.q;
      if (f.status) params.isActive = f.status === 'active';
      if (f.hasServers) params.hasServers = f.hasServers;
      if (f.sortBy) {
        params.sortBy = SORT_KEY_TO_BACKEND[f.sortBy] || f.sortBy;
        params.sortDir = f.sortDir;
      }
      const data = await listCustomers(params);
      setCustomers(data.items || []);
      setTotal(data.total || 0);
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message || 'Failed to load customers');
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, f.q, f.status, f.hasServers, f.sortBy, f.sortDir]);

  useEffect(() => {
    fetch();
  }, [fetch]);
  const { refresh, refreshing, lastUpdated } = useAutoRefresh(fetch);

  const handleSearchChange = useCallback((q) => {
    setF({ q, page: '1' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSortChange = useCallback((sortBy, sortDir) => {
    setF({ sortBy, sortDir });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleCreate = async (payload) => {
    await createCustomer(payload);
    setCreateOpen(false);
    fetch();
  };

  const handleEdit = async (payload) => {
    await updateCustomer(editing.id, payload);
    setEditing(null);
    fetch();
  };

  const handleDelete = (c) => setDeleteTarget(c);

  const filterDefs = [
    {
      key: 'status',
      label: 'Status',
      placeholder: 'All statuses',
      options: [
        { value: '', label: 'All statuses' },
        { value: 'active', label: 'Active' },
        { value: 'inactive', label: 'Inactive' },
      ],
    },
    {
      key: 'hasServers',
      label: 'Servers',
      placeholder: 'Any',
      options: [
        { value: '', label: 'Any' },
        { value: 'yes', label: 'Has servers' },
        { value: 'no', label: 'No servers' },
      ],
    },
  ];
  const filterValues = { status: f.status, hasServers: f.hasServers };
  const applyFilters = (next) => {
    setF({ status: next.status ?? '', hasServers: next.hasServers ?? '', page: '1' });
  };

  const columns = [
    {
      key: 'name',
      label: 'Name',
      mobile: { slot: 'title', render: (c) => c.name },
      render: (c) => (
        <button
          onClick={() => navigate(`/customers/${c.id}`)}
          className="flex items-start gap-2 text-left font-medium text-foreground hover:text-primary"
        >
          {/* Long names wrap left-aligned; the icon stays on the first line. */}
          <Building2 className="mt-[3px] h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 break-words">{c.name}</span>
        </button>
      ),
    },
    {
      key: 'slug',
      label: 'Slug',
      mobile: 'hidden',
      render: (c) => <code className="text-xs text-muted-foreground">{c.slug}</code>,
    },
    {
      key: 'description',
      label: 'Description',
      hideBelow: 'md',
      sortable: false,
      mobile: {
        slot: 'secondary',
        render: (c) => (c.description ? <span className="line-clamp-2">{c.description}</span> : null),
      },
      render: (c) => (
        <span className="text-sm text-muted-foreground line-clamp-1">{c.description || '—'}</span>
      ),
    },
    {
      key: 'servers',
      label: 'Servers',
      searchAccessor: (c) => String(c._count?.servers ?? 0),
      // Phones: next to the "⋯" menu (DataTable `mobile.corner`).
      mobile: 'hidden',
      render: (c) => (
        <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Server className="h-3.5 w-3.5" />
          {c._count?.servers ?? 0}
        </span>
      ),
    },
    {
      key: 'status',
      label: 'Status',
      searchAccessor: (c) => (c.isActive ? 'active' : 'inactive'),
      // Phones: Active / Inactive sections instead of a chip on each card.
      mobile: 'hidden',
      render: (c) => (
        <Badge variant={c.isActive ? 'success' : 'default'}>
          {c.isActive ? 'Active' : 'Inactive'}
        </Badge>
      ),
    },
    {
      key: 'actions',
      label: '',
      className: 'w-10',
      actions: [
        {
          label: 'View',
          icon: Eye,
          onClick: (c) => navigate(`/customers/${c.id}`),
        },
        ...(canManage
          ? [{ label: 'Edit', icon: Pencil, onClick: (c) => setEditing(c) }]
          : []),
        ...(canDelete
          ? [
              { separator: true },
              { label: 'Delete', icon: Trash2, variant: 'destructive', onClick: (c) => handleDelete(c) },
            ]
          : []),
      ],
    },
  ];

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        icon={Building2}
        title="Customers"
        subtitle="Organize servers and access by tenant."
        helpKey="customers"
        onRefresh={refresh}
        refreshing={refreshing}
        lastUpdated={lastUpdated}
        actions={[
          { key: 'add', label: 'Add Customer', icon: Plus, onClick: () => setCreateOpen(true), hidden: !canCreate },
        ]}
      />

      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <DataTable
        columns={columns}
        data={customers}
        loading={loading}
        emptyMessage="No customers yet. Create your first customer to get started."
        emptyState={
          appliedFilterCount(filterDefs, filterValues) > 0 ? (
            <FilteredEmptyState onClear={() => applyFilters(clearedFilterValues(filterDefs))} />
          ) : undefined
        }
        searchPlaceholder="Search customers..."
        initialSearch={f.q}
        onSearchChange={handleSearchChange}
        filterDefs={filterDefs}
        filterValues={filterValues}
        onFilterChange={applyFilters}
        onRowClick={(c) => navigate(`/customers/${c.id}`)}
        serverSort={{ sortKey: f.sortBy, sortDir: f.sortDir, onSortChange: handleSortChange }}
        serverPagination={{
          page,
          total,
          onPageChange: (p) => setF({ page: String(p) }),
          pageSize,
          onPageSizeChange: (size) => setF({ pageSize: String(size), page: '1' }),
        }}
        mobile={{
          leading: () => <CardIcon icon={Building2} />,
          corner: (c) => (
            <span className="flex items-center gap-1 tabular-nums" title="Servers" aria-label={`${c._count?.servers ?? 0} servers`}>
              <Server className="h-3.5 w-3.5" />
              {c._count?.servers ?? 0}
            </span>
          ),
          group: (c) => (c.isActive ? { key: 'active', label: 'Active' } : { key: 'inactive', label: 'Inactive' }),
          groupOrder: ['active', 'inactive'],
        }}
      />

      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="Add customer">
        <CustomerForm onSubmit={handleCreate} onCancel={() => setCreateOpen(false)} />
      </Modal>

      <Modal open={!!editing} onClose={() => setEditing(null)} title="Edit customer">
        {editing && (
          <CustomerForm
            customer={editing}
            onSubmit={handleEdit}
            onCancel={() => setEditing(null)}
          />
        )}
      </Modal>

      <ConfirmDialog
        open={!!confirm}
        title={confirm?.title}
        message={confirm?.message}
        confirmLabel={confirm?.confirmLabel}
        variant={confirm?.variant}
        onConfirm={confirm?.onConfirm}
        onCancel={() => setConfirm(null)}
      />

      <DeleteCustomerDialog
        customer={deleteTarget}
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onDeleted={() => {
          setDeleteTarget(null);
          fetch();
        }}
      />
    </div>
  );
}

export default Customers;
