import { useState, useEffect, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Plus, Building2, Server, Eye, Pencil, Trash2, RefreshCw } from 'lucide-react';
import Badge from '@/components/shared/Badge';
import Modal from '@/components/shared/Modal';
import ConfirmDialog from '@/components/shared/ConfirmDialog';
import DataTable from '@/components/shared/DataTable';
import { CardIcon } from '@/components/mobile/MobileCard';
import CustomerForm from '@/components/customers/CustomerForm';
import PageHeader from '@/components/common/PageHeader';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/context/AuthContext';
import { can } from '@/lib/permissions';
import { listCustomers, createCustomer, updateCustomer } from '@/services/customerService';
import DeleteCustomerDialog from '@/components/customers/DeleteCustomerDialog';

function Customers() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const canCreate = can(user, 'customers.create');
  const canManage = can(user, 'customers.update');
  const canDelete = can(user, 'customers.delete');
  const [customers, setCustomers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [searchParams, setSearchParams] = useSearchParams();

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
      const data = await listCustomers({ page: 1, pageSize: 200 });
      setCustomers(data.items || []);
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message || 'Failed to load customers');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetch();
  }, [fetch]);

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

  const columns = [
    {
      key: 'name',
      label: 'Name',
      sortable: true,
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
      sortable: true,
      mobile: { slot: 'meta', order: 1 },
      render: (c) => <code className="text-xs text-muted-foreground">{c.slug}</code>,
    },
    {
      key: 'description',
      label: 'Description',
      hideBelow: 'md',
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
      sortable: true,
      searchAccessor: (c) => String(c._count?.servers ?? 0),
      mobile: { slot: 'meta', order: 2 },
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
      mobile: { slot: 'meta', order: 3 },
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
      <PageHeader icon={Building2} title="Customers" subtitle="Organize servers and access by tenant." helpKey="customers">
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => fetch()} disabled={loading}>
            <RefreshCw className={`mr-2 h-4 w-4 ${loading ? 'animate-spin' : ''}`} /> Refresh
          </Button>
          {canCreate && (
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="mr-2 h-4 w-4" /> Add Customer
            </Button>
          )}
        </div>
      </PageHeader>

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
        searchPlaceholder="Search customers..."
        onRowClick={(c) => navigate(`/customers/${c.id}`)}
        mobile={{ leading: () => <CardIcon icon={Building2} /> }}
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
