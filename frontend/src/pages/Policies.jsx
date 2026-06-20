import { useState, useEffect, useCallback } from 'react';
import {
  Plus,
  Pencil,
  Trash2,
  Shield,
  FlaskConical,
} from 'lucide-react';
import DataTable from '@/components/shared/DataTable';
import ConfirmDialog from '@/components/shared/ConfirmDialog';
import EnvironmentBadge from '@/components/shared/EnvironmentBadge';
import Badge from '@/components/shared/Badge';
import PolicyForm from '@/components/policies/PolicyForm';
import PolicyEvaluator from '@/components/policies/PolicyEvaluator';
import PageHeader from '@/components/common/PageHeader';
import { Button } from '@/components/ui/button';
import SearchableSelect from '@/components/ui/SearchableSelect';
import { listPolicies, createPolicy, updatePolicy, deletePolicy } from '@/services/policyService';
import { listCustomers } from '@/services/customerService';
import { useAuth } from '@/context/AuthContext';
import { relativeTime } from '@/utils/time';

const ROLE_RANK = { super_admin: 4, admin: 3, manager: 2, member: 1 };
function isAtLeast(user, role) {
  return (ROLE_RANK[user?.role] || 0) >= (ROLE_RANK[role] || 0);
}

function EffectBadge({ effect }) {
  if (effect === 'ALLOW') return <Badge variant="success">ALLOW</Badge>;
  return <Badge variant="danger">DENY</Badge>;
}

function Policies() {
  const { user } = useAuth();
  const canAdmin = isAtLeast(user, 'admin');

  const [policies, setPolicies] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [effectFilter, setEffectFilter] = useState('');
  const [customerFilter, setCustomerFilter] = useState('');
  const [activeFilter, setActiveFilter] = useState('');
  const [customers, setCustomers] = useState([]);

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [evaluatorPolicy, setEvaluatorPolicy] = useState(null);

  const fetchCustomers = useCallback(async () => {
    try {
      const d = await listCustomers({ page: 1, pageSize: 200 });
      setCustomers(d.items || []);
    } catch { /* ignore */ }
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
      setPolicies(items);
      setTotal(metaTotal);
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message || 'Failed to load policies');
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, effectFilter, customerFilter, activeFilter]);

  useEffect(() => { fetchCustomers(); }, [fetchCustomers]);
  useEffect(() => { fetchPolicies(); }, [fetchPolicies]);

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

  const filterSlot = (
    <>
      <SearchableSelect
        className="w-[140px]"
        value={effectFilter}
        onChange={(v) => { setEffectFilter(v); setPage(1); }}
        options={[
          { value: '', label: 'All effects' },
          { value: 'ALLOW', label: 'ALLOW' },
          { value: 'DENY', label: 'DENY' },
        ]}
        placeholder="All effects"
        searchable={false}
        clearable={false}
      />
      <SearchableSelect
        className="w-[160px]"
        value={customerFilter}
        onChange={(v) => { setCustomerFilter(v); setPage(1); }}
        options={[
          { value: '', label: 'All customers' },
          ...customers.map((c) => ({ value: c.id, label: c.name })),
        ]}
        placeholder="All customers"
        searchable={true}
        clearable={false}
      />
      <SearchableSelect
        className="w-[140px]"
        value={activeFilter}
        onChange={(v) => { setActiveFilter(v); setPage(1); }}
        options={[
          { value: '', label: 'All statuses' },
          { value: 'true', label: 'Active' },
          { value: 'false', label: 'Inactive' },
        ]}
        placeholder="All statuses"
        searchable={false}
        clearable={false}
      />
    </>
  );

  const columns = [
    {
      key: 'name',
      label: 'Name',
      sortable: true,
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
      sortable: true,
      searchAccessor: (r) => r.effect || '',
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
      hideBelow: 'md',
      render: (r) => {
        const envs = r.targetEnvironments || [];
        if (envs.length === 0) return <span className="text-xs text-muted-foreground">All</span>;
        return (
          <div className="flex flex-wrap gap-1">
            {envs.map((e) => <EnvironmentBadge key={e} environment={e} />)}
          </div>
        );
      },
    },
    {
      key: 'subjects',
      label: 'Subjects',
      hideBelow: 'lg',
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
      sortable: true,
      render: (r) => (
        <span className="font-mono text-xs text-muted-foreground">{r.priority ?? 0}</span>
      ),
    },
    {
      key: 'isActive',
      label: 'Status',
      searchAccessor: (r) => (r.isActive ? 'active' : 'inactive'),
      render: (r) =>
        r.isActive ? <Badge variant="success">Active</Badge> : <Badge variant="default">Inactive</Badge>,
    },
    {
      key: 'updatedAt',
      label: 'Updated',
      sortable: true,
      hideBelow: 'lg',
      render: (r) => (
        <span className="text-xs text-muted-foreground">{relativeTime(r.updatedAt)}</span>
      ),
    },
    ...(canAdmin
      ? [{
          key: 'actions',
          label: '',
          className: 'w-10',
          actions: [
            { label: 'Edit', icon: Pencil, onClick: (r) => { setEditing(r); setFormOpen(true); } },
            { label: 'Test', icon: FlaskConical, onClick: (r) => setEvaluatorPolicy(r) },
            { separator: true },
            { label: 'Delete', icon: Trash2, variant: 'destructive', onClick: (r) => handleDelete(r) },
          ],
        }]
      : []),
  ];

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        icon={Shield}
        title="Policies"
        subtitle="Access control policies governing who can reach which servers." helpKey="policies">
        {canAdmin && (
          <Button onClick={() => { setEditing(null); setFormOpen(true); }}>
            <Plus className="mr-2 h-4 w-4" /> New Policy
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
        data={policies}
        loading={loading}
        emptyMessage="No policies found. Create one to control server access."
        searchPlaceholder="Search by policy name..."
        filters={filterSlot}
        serverPagination={{
          page,
          total,
          onPageChange: setPage,
          pageSize,
          onPageSizeChange: (size) => { setPageSize(size); setPage(1); },
        }}
      />

      <PolicyForm
        open={formOpen}
        onClose={() => { setFormOpen(false); setEditing(null); }}
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

      <PolicyEvaluator
        open={!!evaluatorPolicy}
        onClose={() => setEvaluatorPolicy(null)}
        policy={evaluatorPolicy}
      />
    </div>
  );
}

export default Policies;
