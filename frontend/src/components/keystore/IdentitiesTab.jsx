import { useCallback, useEffect, useImperativeHandle, useMemo, useState, forwardRef } from 'react';
import { Pencil, Trash2, PlugZap, Eye, KeyRound, Lock, Server } from 'lucide-react';
import { authTypeTone } from '@/lib/badgeTones';
import DataTable from '@/components/shared/DataTable';
import { CardIcon } from '@/components/mobile/MobileCard';
import ConfirmDialog from '@/components/shared/ConfirmDialog';
import EmptyState from '@/components/ui/EmptyState';
import FilteredEmptyState from '@/components/shared/FilteredEmptyState';
import { appliedFilterCount, clearedFilterValues } from '@/lib/filters';
import AuthTypeBadge from './AuthTypeBadge';
import IdentityFormModal from './IdentityFormModal';
import IdentityDetailModal from './IdentityDetailModal';
import TestConnectionModal from './TestConnectionModal';
import { listCredentials, deleteCredential } from '@/services/keystoreService';
import { relativeTime, formatDateTime } from '@/utils/time';

const IdentitiesTab = forwardRef(function IdentitiesTab({ canManage, scope = 'org', canMoveToOrg = false }, ref) {
  const [credentials, setCredentials] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [detailId, setDetailId] = useState(null);
  const [testTarget, setTestTarget] = useState(null);

  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleteError, setDeleteError] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [inUseInfo, setInUseInfo] = useState(null);

  const [authTypeFilter, setAuthTypeFilter] = useState('');
  const [usageFilter, setUsageFilter] = useState('');

  const fetch = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await listCredentials({ scope });
      setCredentials(data);
      return data;
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message || 'Failed to load identities');
      return [];
    } finally {
      setLoading(false);
    }
  }, [scope]);

  useEffect(() => {
    fetch();
  }, [fetch]);

  useImperativeHandle(ref, () => ({
    openNew: () => {
      setEditing(null);
      setFormOpen(true);
    },
    highlight: (id) => setDetailId(id),
  }));

  const handleDelete = async (force = false) => {
    if (!deleteTarget) return;
    setDeleting(true);
    setDeleteError('');
    try {
      await deleteCredential(deleteTarget.id, { force });
      setDeleteTarget(null);
      setInUseInfo(null);
      fetch();
    } catch (err) {
      const code = err.response?.data?.error?.code;
      if (code === 'CREDENTIAL_IN_USE' && !force) {
        setInUseInfo({
          message:
            err.response?.data?.error?.message ||
            'This identity is used by one or more servers.',
        });
      } else {
        setDeleteError(err.response?.data?.error?.message || err.message || 'Failed to delete identity');
      }
    } finally {
      setDeleting(false);
    }
  };

  const filterDefs = [
    {
      key: 'authType',
      label: 'Auth type',
      placeholder: 'All types',
      options: [
        { value: '', label: 'All types' },
        { value: 'password', label: 'Password' },
        { value: 'key', label: 'Private key' },
        { value: 'key_password', label: 'Key + password' },
      ],
    },
    {
      key: 'usage',
      label: 'Last used',
      placeholder: 'Any',
      options: [
        { value: '', label: 'Any' },
        { value: 'used', label: 'Used at least once' },
        { value: 'never', label: 'Never used' },
      ],
    },
  ];
  const filterValues = { authType: authTypeFilter, usage: usageFilter };
  const applyFilters = (next) => {
    setAuthTypeFilter(next.authType ?? '');
    setUsageFilter(next.usage ?? '');
  };

  const filteredCredentials = useMemo(() => {
    return credentials.filter((c) => {
      if (authTypeFilter && (c.authType || '').toLowerCase() !== authTypeFilter) return false;
      if (usageFilter === 'used' && !c.lastUsedAt) return false;
      if (usageFilter === 'never' && c.lastUsedAt) return false;
      return true;
    });
  }, [credentials, authTypeFilter, usageFilter]);

  const columns = [
    {
      key: 'name',
      label: 'Name',
      sortable: true,
      searchAccessor: (r) => `${r.name} ${r.username}`,
      mobile: {
        slot: 'title',
        render: (r) => (
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="min-w-0 break-words">{r.name}</span>
            {scope === 'personal' && <Lock className="h-3 w-3 shrink-0 text-muted-foreground" aria-label="Private" />}
          </span>
        ),
      },
      render: (r) => (
        <div>
          <span className="flex items-center gap-1.5 font-medium text-foreground">
            {r.name}
            {scope === 'personal' && <Lock className="h-3 w-3 shrink-0 text-muted-foreground" aria-label="Private" />}
          </span>
          <span className="block font-mono text-[11px] text-muted-foreground">{r.username}</span>
        </div>
      ),
    },
    {
      key: 'authType',
      label: 'Auth',
      // Phones: plain text under the username, no chip.
      mobile: { slot: 'meta', order: 1, render: (r) => authTypeTone(r.authType).label },
      render: (r) => <AuthTypeBadge authType={r.authType} />,
    },
    {
      key: 'sshKey',
      label: 'Linked key',
      mobile: 'hidden',
      render: (r) =>
        r.sshKey ? (
          <span>
            <span className="block text-foreground">{r.sshKey.name}</span>
            <span className="block font-mono text-[11px] text-muted-foreground">{r.sshKey.fingerprint}</span>
          </span>
        ) : (
          <span className="text-muted-foreground">-</span>
        ),
    },
    ...(scope === 'personal'
      ? []
      : [
          {
            key: 'serverCount',
            label: 'Servers',
            sortable: true,
            // Phones: next to the "⋯" menu (DataTable `mobile.corner`).
            mobile: 'hidden',
            render: (r) => <span className="tabular-nums">{r.serverCount ?? 0}</span>,
          },
        ]),
    {
      key: 'lastUsedAt',
      label: 'Last used',
      sortable: true,
      mobile: {
        slot: 'secondary',
        render: (r) => (
          <span>
            <span className="font-mono">{r.username}</span> · {r.lastUsedAt ? `used ${relativeTime(r.lastUsedAt)}` : 'never used'}
          </span>
        ),
      },
      render: (r) => (
        <span className="text-xs text-muted-foreground" title={formatDateTime(r.lastUsedAt)}>
          {r.lastUsedAt ? relativeTime(r.lastUsedAt) : 'Never'}
        </span>
      ),
    },
    {
      key: 'actions',
      label: '',
      className: 'w-10',
      actions: [
        { label: 'View details', icon: Eye, onClick: (r) => setDetailId(r.id) },
        { label: 'Test connection', icon: PlugZap, onClick: (r) => setTestTarget(r) },
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
              { separator: true },
              {
                label: 'Delete',
                icon: Trash2,
                variant: 'destructive',
                onClick: (r) => {
                  setDeleteTarget(r);
                  setInUseInfo(null);
                  setDeleteError('');
                },
              },
            ]
          : []),
      ],
    },
  ];

  return (
    <div className="space-y-4">
      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {!loading && credentials.length === 0 ? (
        <EmptyState
          icon={scope === 'personal' ? Lock : KeyRound}
          title={scope === 'personal' ? 'No personal identities yet' : 'No identities yet'}
          description={
            scope === 'personal'
              ? "Keep your own username and password/key here — visible only to you, never to admins or other Keystore viewers."
              : "Identities pair a username and password/key so Shellius can connect to hosts that can't be bootstrapped with a CA certificate."
          }
          action={canManage ? { label: 'New identity', onClick: () => setFormOpen(true) } : undefined}
        />
      ) : (
        <DataTable
          columns={columns}
          data={filteredCredentials}
          loading={loading}
          onRowClick={(r) => setDetailId(r.id)}
          searchPlaceholder="Search identities..."
          emptyMessage="No identities match your search"
          emptyState={
            appliedFilterCount(filterDefs, filterValues) > 0 ? (
              <FilteredEmptyState onClear={() => applyFilters(clearedFilterValues(filterDefs))} />
            ) : undefined
          }
          filterDefs={filterDefs}
          filterValues={filterValues}
          onFilterChange={applyFilters}
          mobile={{
            leading: () => <CardIcon icon={scope === 'personal' ? Lock : KeyRound} />,
            corner:
              scope === 'personal'
                ? undefined
                : (r) => (
                    <span className="flex items-center gap-1 tabular-nums" title="Servers" aria-label={`${r.serverCount ?? 0} servers`}>
                      <Server className="h-3.5 w-3.5" />
                      {r.serverCount ?? 0}
                    </span>
                  ),
          }}
        />
      )}

      <IdentityFormModal
        open={formOpen}
        onClose={() => {
          setFormOpen(false);
          setEditing(null);
        }}
        identity={editing}
        scope={scope}
        onSaved={fetch}
      />

      <IdentityDetailModal
        open={!!detailId}
        credentialId={detailId}
        canManage={canManage}
        scope={scope}
        canMoveToOrg={canMoveToOrg}
        onClose={() => setDetailId(null)}
        onChanged={fetch}
      />

      {testTarget && (
        <TestConnectionModal
          open={!!testTarget}
          credential={testTarget}
          scope={scope}
          onClose={() => setTestTarget(null)}
        />
      )}

      <ConfirmDialog
        open={!!deleteTarget && !inUseInfo}
        title="Delete identity"
        message={`Permanently delete "${deleteTarget?.name}"? This cannot be undone.`}
        confirmLabel={deleting ? 'Deleting...' : 'Delete'}
        variant="destructive"
        onConfirm={() => handleDelete(false)}
        onCancel={() => {
          setDeleteTarget(null);
          setDeleteError('');
        }}
      />

      <ConfirmDialog
        open={!!deleteTarget && !!inUseInfo}
        title="Identity in use"
        message={`${inUseInfo?.message || ''} Force-deleting will detach it from every server — those servers revert to certificate-mode (CA) authentication.`}
        confirmLabel={deleting ? 'Detaching...' : 'Force detach & delete'}
        variant="destructive"
        onConfirm={() => handleDelete(true)}
        onCancel={() => {
          setDeleteTarget(null);
          setInUseInfo(null);
        }}
      />

      {deleteError && (
        <div className="fixed bottom-4 right-4 z-50 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive shadow-lg">
          {deleteError}
        </div>
      )}
    </div>
  );
});

export default IdentitiesTab;
