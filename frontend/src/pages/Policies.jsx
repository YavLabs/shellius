import { useState, useEffect, useCallback, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Plus,
  Pencil,
  Trash2,
  Shield,
  FlaskConical,
} from 'lucide-react';
import DataTable from '@/components/shared/DataTable';
import ConfirmDialog from '@/components/shared/ConfirmDialog';
import DeletePolicyDialog from '@/components/policies/DeletePolicyDialog';
import EnvironmentBadge from '@/components/shared/EnvironmentBadge';
import { Badge } from '@/components/ui/badge';
import { policyEffectTone } from '@/lib/badgeTones';
import { CardStatus } from '@/components/mobile/MobileCard';
import PolicyForm from '@/components/policies/PolicyForm';
import PolicyEvaluator from '@/components/policies/PolicyEvaluator';
import PageHeader from '@/components/common/PageHeader';
import { Button } from '@/components/ui/button';
import SearchableSelect from '@/components/ui/SearchableSelect';
import { listPolicies, createPolicy, updatePolicy, getPolicy } from '@/services/policyService';
import { listCustomers } from '@/services/customerService';
import { listGroups } from '@/services/groupService';
import { useAuth } from '@/context/AuthContext';
import { relativeTime } from '@/utils/time';
import { can } from '@/lib/permissions';
import { ENVIRONMENT_LABELS } from '@/lib/labels';
import useAutoRefresh from '@/hooks/useAutoRefresh';
import useUrlFilters from '@/hooks/useUrlFilters';

const ENVIRONMENTS = ['demo', 'dev', 'staging', 'prod'];
// Column key -> backend sortBy for listPolicies.
const SORT_KEY_TO_BACKEND = {
  name: 'name',
  effect: 'effect',
  priority: 'priority',
  isActive: 'isActive',
  updatedAt: 'updatedAt',
};


function EffectBadge({ effect }) {
  const { tone, label } = policyEffectTone(effect);
  return <Badge tone={tone}>{label}</Badge>;
}

function Policies() {
  const { user } = useAuth();
  const canAdmin = can(user, 'policies.manage');

  const [policies, setPolicies] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [f, setF] = useUrlFilters({
    q: '',
    effect: '',
    customerId: '',
    orgWide: '',
    active: '',
    environment: '',
    subjectUser: '',
    subjectGroup: '',
    sortBy: '',
    sortDir: 'asc',
    page: '1',
    pageSize: '20',
  });
  const page = parseInt(f.page, 10) || 1;
  const pageSize = parseInt(f.pageSize, 10) || 20;
  const [customers, setCustomers] = useState([]);
  const [groups, setGroups] = useState([]);

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [evaluatorPolicy, setEvaluatorPolicy] = useState(null);
  const [searchParams, setSearchParams] = useSearchParams();

  // Deep links: /policies?action=new opens the create modal; ?highlight=<id>
  // opens that policy's edit modal (DataTable has no row-highlight affordance).
  // Depends on `searchParams`, not on mount — same reason as Users.jsx: a
  // link to ?highlight=<id> from this very page changes the query string
  // without remounting, so a mount-only effect never fired.
  useEffect(() => {
    const action = searchParams.get('action');
    const highlightId = searchParams.get('highlight');
    if (!action && !highlightId) return;
    if (action === 'new' && canAdmin) {
      setEditing(null);
      setFormOpen(true);
    } else if (highlightId && canAdmin) {
      getPolicy(highlightId)
        .then((p) => {
          if (p) {
            setEditing(p);
            setFormOpen(true);
          }
        })
        .catch(() => {});
    }
    if (action || highlightId) {
      const next = new URLSearchParams(searchParams);
      next.delete('action');
      next.delete('highlight');
      setSearchParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const fetchCustomers = useCallback(async () => {
    try {
      const d = await listCustomers({ page: 1, pageSize: 200 });
      setCustomers(d.items || []);
    } catch { /* ignore */ }
  }, []);

  const fetchGroups = useCallback(async () => {
    try {
      const rows = await listGroups();
      setGroups(rows || []);
    } catch { /* ignore */ }
  }, []);

  const loadedRef = useRef(false);
  const fetchPolicies = useCallback(async () => {
    if (!loadedRef.current) setLoading(true);
    setError('');
    try {
      // Bug fix: this used to send `limit`, which listPolicies (backend
      // reads `pageSize`) silently ignored — every page came back with the
      // default 25 regardless of the page size picked here.
      const params = { page, pageSize };
      if (f.effect) params.effect = f.effect;
      if (f.orgWide === 'true') params.orgWide = true;
      else if (f.customerId) params.customerId = f.customerId;
      if (f.active !== '') params.isActive = f.active === 'true';
      if (f.environment) params.environment = f.environment;
      // Either subject filter narrows to policies naming that user or group
      // as a subject — the backend param is a single `subjectId` regardless
      // of subject type.
      if (f.subjectUser) params.subjectId = f.subjectUser;
      else if (f.subjectGroup) params.subjectId = f.subjectGroup;
      if (f.q) params.search = f.q;
      if (f.sortBy) {
        params.sortBy = SORT_KEY_TO_BACKEND[f.sortBy] || f.sortBy;
        params.sortDir = f.sortDir;
      }
      const resp = await listPolicies(params);
      const items = resp.data?.items || resp.data || [];
      const metaTotal = resp.meta?.total ?? resp.data?.total ?? items.length;
      setPolicies(items);
      setTotal(metaTotal);
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message || 'Failed to load policies');
    } finally {
      setLoading(false);
      loadedRef.current = true;
    }
  }, [page, pageSize, f.effect, f.orgWide, f.customerId, f.active, f.environment, f.subjectUser, f.subjectGroup, f.q, f.sortBy, f.sortDir]);

  // One function so the header's Refresh button reloads both the table and
  // the customer filter options.
  const loadAll = useCallback(async () => {
    await Promise.all([fetchPolicies(), fetchCustomers(), fetchGroups()]);
  }, [fetchPolicies, fetchCustomers, fetchGroups]);
  const { refresh, refreshing, lastUpdated } = useAutoRefresh(loadAll);

  useEffect(() => { fetchCustomers(); }, [fetchCustomers]);
  useEffect(() => { fetchGroups(); }, [fetchGroups]);
  useEffect(() => { fetchPolicies(); }, [fetchPolicies]);

  const handleSearchChange = useCallback((q) => {
    setF({ q, page: '1' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSortChange = useCallback((sortBy, sortDir) => {
    setF({ sortBy, sortDir });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  const handleDelete = (policy) => setDeleteTarget(policy);

  const customerMap = Object.fromEntries(customers.map((c) => [c.id, c.name]));

  const filterDefs = [
    {
      key: 'effect',
      label: 'Effect',
      placeholder: 'All effects',
      options: [
        { value: '', label: 'All effects' },
        { value: 'ALLOW', label: 'Allow' },
        { value: 'DENY', label: 'Deny' },
      ],
    },
    {
      key: 'orgWide',
      label: 'Scope',
      placeholder: 'Org-wide and customer',
      options: [
        { value: '', label: 'Org-wide and customer' },
        { value: 'true', label: 'Org-wide only' },
      ],
    },
    {
      key: 'customerId',
      label: 'Customer',
      placeholder: 'All customers',
      searchable: true,
      options: [
        { value: '', label: 'All customers' },
        ...customers.map((c) => ({ value: c.id, label: c.name })),
      ],
    },
    {
      key: 'environment',
      label: 'Environment',
      placeholder: 'All environments',
      options: [
        { value: '', label: 'All environments' },
        ...ENVIRONMENTS.map((e) => ({ value: e, label: ENVIRONMENT_LABELS[e] || e })),
      ],
    },
    {
      key: 'active',
      label: 'Status',
      placeholder: 'All statuses',
      options: [
        { value: '', label: 'All statuses' },
        { value: 'true', label: 'Active' },
        { value: 'false', label: 'Inactive' },
      ],
    },
    { key: 'subjectUser', label: 'Subject (user)', placeholder: 'Any user', type: 'entity', entity: 'users' },
    {
      key: 'subjectGroup',
      label: 'Subject (group)',
      placeholder: 'Any group',
      searchable: true,
      options: [
        { value: '', label: 'Any group' },
        ...groups.map((g) => ({ value: g.id, label: g.name })),
      ],
    },
  ];
  const filterValues = {
    effect: f.effect,
    orgWide: f.orgWide,
    customerId: f.customerId,
    environment: f.environment,
    active: f.active,
    subjectUser: f.subjectUser,
    subjectGroup: f.subjectGroup,
  };
  const applyFilters = (next) => {
    setF({
      effect: next.effect ?? '',
      orgWide: next.orgWide ?? '',
      // Org-wide and a specific customer are mutually exclusive.
      customerId: next.orgWide === 'true' ? '' : next.customerId ?? '',
      environment: next.environment ?? '',
      active: next.active ?? '',
      subjectUser: next.subjectUser ?? '',
      subjectGroup: next.subjectUser ? '' : next.subjectGroup ?? '',
      page: '1',
    });
  };

  const columns = [
    {
      key: 'name',
      label: 'Name',
      sortable: true,
      mobile: {
        slot: 'title',
        render: (r) => (
          r.name
        ),
      },
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
      // Phones: quiet effect next to the "⋯" menu (DataTable `mobile.corner`).
      mobile: 'hidden',
      render: (r) => <EffectBadge effect={r.effect} />,
    },
    {
      key: 'scope',
      label: 'Scope',
      sortable: false,
      mobile: { slot: 'secondary', order: 1 },
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
      sortable: false,
      mobile: 'hidden',
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
      sortable: false,
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
      mobile: {
        slot: 'secondary',
        order: 2,
        render: (r) => `Priority ${r.priority ?? 0}${r.isActive ? '' : ' · Inactive'}`,
      },
      render: (r) => (
        <span className="font-mono text-xs text-muted-foreground">{r.priority ?? 0}</span>
      ),
    },
    {
      key: 'isActive',
      label: 'Status',
      searchAccessor: (r) => (r.isActive ? 'active' : 'inactive'),
      mobile: 'hidden',
      render: (r) =>
        r.isActive ? <Badge tone="success">Active</Badge> : <Badge tone="neutral">Inactive</Badge>,
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
        subtitle="Access control policies governing who can reach which servers."
        helpKey="policies"
        onRefresh={refresh}
        refreshing={refreshing}
        lastUpdated={lastUpdated}
        actions={[
          {
            key: 'new',
            label: 'New Policy',
            icon: Plus,
            hidden: !canAdmin,
            onClick: () => {
              setEditing(null);
              setFormOpen(true);
            },
          },
        ]}
      />

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
        searchPlaceholder="Search by name or description..."
        initialSearch={f.q}
        onSearchChange={handleSearchChange}
        filterDefs={filterDefs}
        filterValues={filterValues}
        onFilterChange={applyFilters}
        mobile={{ corner: (r) => <CardStatus {...policyEffectTone(r.effect)} /> }}
        serverSort={{ sortKey: f.sortBy, sortDir: f.sortDir, onSortChange: handleSortChange }}
        serverPagination={{
          page,
          total,
          onPageChange: (p) => setF({ page: String(p) }),
          pageSize,
          onPageSizeChange: (size) => setF({ pageSize: String(size), page: '1' }),
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

      <DeletePolicyDialog
        policy={deleteTarget}
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onDeleted={() => {
          setDeleteTarget(null);
          fetchPolicies();
        }}
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
