import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Building2, Server } from 'lucide-react';
import SearchInput from '@/components/shared/SearchInput';
import Badge from '@/components/shared/Badge';
import Modal from '@/components/shared/Modal';
import CustomerForm from '@/components/customers/CustomerForm';
import { listCustomers, createCustomer } from '@/services/customerService';

function Customers() {
  const navigate = useNavigate();
  const [customers, setCustomers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [createOpen, setCreateOpen] = useState(false);

  const fetch = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = { page: 1, pageSize: 100 };
      if (search) params.search = search;
      const data = await listCustomers(params);
      setCustomers(data.items || []);
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message || 'Failed to load customers');
    } finally {
      setLoading(false);
    }
  }, [search]);

  useEffect(() => {
    fetch();
  }, [fetch]);

  const handleCreate = async (payload) => {
    await createCustomer(payload);
    setCreateOpen(false);
    fetch();
  };

  return (
    <div className="space-y-5 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Customers</h1>
          <p className="text-sm text-muted-foreground">
            Organize servers and access by tenant.
          </p>
        </div>
        <button
          onClick={() => setCreateOpen(true)}
          className="flex h-9 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          <Plus className="h-4 w-4" /> Add Customer
        </button>
      </div>

      <div className="max-w-md">
        <SearchInput value={search} onChange={setSearch} placeholder="Search customers..." />
      </div>

      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {loading ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-36 animate-pulse rounded-lg border border-border bg-card" />
          ))}
        </div>
      ) : customers.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border bg-card p-10 text-center">
          <Building2 className="mx-auto h-8 w-8 text-muted-foreground" />
          <p className="mt-3 text-sm text-muted-foreground">
            No customers yet. Create your first customer to get started.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {customers.map((c) => (
            <button
              key={c.id}
              onClick={() => navigate(`/customers/${c.id}`)}
              className="group flex flex-col items-start rounded-lg border border-border bg-card p-5 text-left transition-all hover:border-primary/50 hover:shadow-sm"
            >
              <div className="flex w-full items-start justify-between">
                <div className="flex h-9 w-9 items-center justify-center rounded-md bg-primary/10 text-primary">
                  <Building2 className="h-5 w-5" />
                </div>
                <Badge variant={c.isActive ? 'success' : 'default'}>
                  {c.isActive ? 'Active' : 'Inactive'}
                </Badge>
              </div>
              <h3 className="mt-3 text-base font-semibold text-foreground group-hover:text-primary">
                {c.name}
              </h3>
              <code className="mt-0.5 text-xs text-muted-foreground">{c.slug}</code>
              {c.description && (
                <p className="mt-2 line-clamp-2 text-sm text-muted-foreground">
                  {c.description}
                </p>
              )}
              <div className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
                <Server className="h-3.5 w-3.5" />
                {c._count?.servers ?? 0} server{(c._count?.servers ?? 0) === 1 ? '' : 's'}
              </div>
            </button>
          ))}
        </div>
      )}

      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="Add Customer">
        <CustomerForm onSubmit={handleCreate} onCancel={() => setCreateOpen(false)} />
      </Modal>
    </div>
  );
}

export default Customers;
