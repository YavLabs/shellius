import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Building2, Server, Eye, Pencil, Trash2 } from 'lucide-react';
import Badge from '@/components/shared/Badge';
import Modal from '@/components/shared/Modal';
import ConfirmDialog from '@/components/shared/ConfirmDialog';
import DataTable from '@/components/shared/DataTable';
import CustomerForm from '@/components/customers/CustomerForm';
import PageHeader from '@/components/common/PageHeader';
import { Button } from '@/components/ui/button';
import { listCustomers, createCustomer, updateCustomer, deleteCustomer } from '@/services/customerService';

function Customers() {
  const navigate = useNavigate();
  const [customers, setCustomers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [confirm, setConfirm] = useState(null);

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

  const handleDelete = (c) => {
    setConfirm({
      title: 'Delete customer',
      message: `Permanently delete "${c.name}"? This cannot be undone.`,
      variant: 'destructive',
      confirmLabel: 'Delete',
      onConfirm: async () => {
        await deleteCustomer(c.id);
        setConfirm(null);
        fetch();
      },
    });
  };

  const columns = [
    {
      key: 'name',
      label: 'Name',
      sortable: true,
      render: (c) => (
        <button
          onClick={() => navigate(`/customers/${c.id}`)}
          className="flex items-center gap-2 font-medium text-foreground hover:text-primary"
        >
          <Building2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          {c.name}
        </button>
      ),
    },
    {
      key: 'slug',
      label: 'Slug',
      sortable: true,
      render: (c) => <code className="text-xs text-muted-foreground">{c.slug}</code>,
    },
    {
      key: 'description',
      label: 'Description',
      hideBelow: 'md',
      render: (c) => (
        <span className="text-sm text-muted-foreground line-clamp-1">{c.description || '—'}</span>
      ),
    },
    {
      key: 'servers',
      label: 'Servers',
      sortable: true,
      searchAccessor: (c) => String(c._count?.servers ?? 0),
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
        {
          label: 'Edit',
          icon: Pencil,
          onClick: (c) => setEditing(c),
        },
        { separator: true },
        {
          label: 'Delete',
          icon: Trash2,
          variant: 'destructive',
          onClick: (c) => handleDelete(c),
        },
      ],
    },
  ];

  return (
    <div className="space-y-6 p-6">
      <PageHeader icon={Building2} title="Customers" subtitle="Organize servers and access by tenant." helpKey="customers">
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="mr-2 h-4 w-4" /> Add Customer
        </Button>
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
      />

      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="Add Customer">
        <CustomerForm onSubmit={handleCreate} onCancel={() => setCreateOpen(false)} />
      </Modal>

      <Modal open={!!editing} onClose={() => setEditing(null)} title="Edit Customer">
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
    </div>
  );
}

export default Customers;
