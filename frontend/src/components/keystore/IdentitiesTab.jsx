import { useCallback, useEffect, useImperativeHandle, useState, forwardRef } from 'react';
import { Pencil, Trash2, PlugZap, Eye, KeyRound } from 'lucide-react';
import DataTable from '@/components/shared/DataTable';
import ConfirmDialog from '@/components/shared/ConfirmDialog';
import EmptyState from '@/components/ui/EmptyState';
import AuthTypeBadge from './AuthTypeBadge';
import IdentityFormModal from './IdentityFormModal';
import IdentityDetailModal from './IdentityDetailModal';
import TestConnectionModal from './TestConnectionModal';
import { listCredentials, deleteCredential } from '@/services/keystoreService';
import { relativeTime, formatDateTime } from '@/utils/time';

const IdentitiesTab = forwardRef(function IdentitiesTab({ canManage }, ref) {
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

  const fetch = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await listCredentials();
      setCredentials(data);
      return data;
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message || 'Failed to load identities');
      return [];
    } finally {
      setLoading(false);
    }
  }, []);

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

  const columns = [
    {
      key: 'name',
      label: 'Name',
      sortable: true,
      searchAccessor: (r) => `${r.name} ${r.username}`,
      render: (r) => (
        <button
          onClick={() => setDetailId(r.id)}
          className="text-left hover:text-primary"
        >
          <span className="block font-medium text-foreground">{r.name}</span>
          <span className="block font-mono text-[11px] text-muted-foreground">{r.username}</span>
        </button>
      ),
    },
    {
      key: 'authType',
      label: 'Auth',
      render: (r) => <AuthTypeBadge authType={r.authType} />,
    },
    {
      key: 'sshKey',
      label: 'Linked key',
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
    {
      key: 'serverCount',
      label: 'Servers',
      sortable: true,
      render: (r) => <span className="tabular-nums">{r.serverCount ?? 0}</span>,
    },
    {
      key: 'lastUsedAt',
      label: 'Last used',
      sortable: true,
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

      <DataTable
        columns={columns}
        data={credentials}
        loading={loading}
        searchPlaceholder="Search identities..."
        emptyState={
          <EmptyState
            icon={KeyRound}
            title="No identities yet"
            description="Identities pair a username and password/key so Shellius can connect to hosts that can't be bootstrapped with a CA certificate."
            action={canManage ? { label: 'New identity', onClick: () => setFormOpen(true) } : undefined}
          />
        }
      />

      <IdentityFormModal
        open={formOpen}
        onClose={() => {
          setFormOpen(false);
          setEditing(null);
        }}
        identity={editing}
        onSaved={fetch}
      />

      <IdentityDetailModal open={!!detailId} credentialId={detailId} onClose={() => setDetailId(null)} />

      {testTarget && (
        <TestConnectionModal
          open={!!testTarget}
          credential={testTarget}
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
