import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Lock,
  Plus,
  Pencil,
  Trash2,
  KeyRound,
  ShieldOff,
  Terminal as TerminalIcon,
  Loader2,
  AlertTriangle,
} from 'lucide-react';
import DataTable from '@/components/shared/DataTable';
import ConfirmDialog from '@/components/shared/ConfirmDialog';
import EmptyState from '@/components/ui/EmptyState';
import PageHeader from '@/components/common/PageHeader';
import ScopeBadge from '@/components/shared/ScopeBadge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import HostFormModal from '@/components/vault/HostFormModal';
import HostConnectAuthModal from '@/components/vault/HostConnectAuthModal';
import {
  getVaultStatus,
  listVaultHosts,
  deleteVaultHost,
  connectVaultHost,
  resetVaultHostKey,
} from '@/services/vaultService';
import { useTerminalWorkspace } from '@/context/TerminalWorkspaceContext';
import { statusTone } from '@/lib/badgeTones';
import { relativeTime, formatDateTime } from '@/utils/time';

function MyHosts() {
  const navigate = useNavigate();
  const { openTab } = useTerminalWorkspace();
  const [searchParams, setSearchParams] = useSearchParams();

  const [status, setStatus] = useState(undefined); // undefined = loading
  const [hosts, setHosts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [authTarget, setAuthTarget] = useState(null); // host awaiting one-off auth
  const [connectingId, setConnectingId] = useState(null);
  const [connectError, setConnectError] = useState(null);
  const [resetTarget, setResetTarget] = useState(null);
  const [resetting, setResetting] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');

  const fetchStatus = useCallback(() => {
    getVaultStatus()
      .then(setStatus)
      .catch(() => setStatus({ enabled: false, canUseVault: false, canUseHosts: false, canUseOrgIdentities: false }));
  }, []);

  const fetchHosts = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await listVaultHosts();
      setHosts(data);
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message || 'Failed to load your hosts');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  useEffect(() => {
    fetchHosts();
  }, [fetchHosts]);

  // Deep link: /my-hosts?action=new
  useEffect(() => {
    if (searchParams.get('action') === 'new') {
      setEditing(null);
      setFormOpen(true);
      const next = new URLSearchParams(searchParams);
      next.delete('action');
      setSearchParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openTerminalFromTicket = (resp, host) => {
    const label = `${host.username || host.credential?.username || 'user'}@${host.host}`;
    openTab(
      { ticket: resp.ticket },
      { label, host: host.host, username: host.username || host.credential?.username, focus: true }
    );
  };

  const describeConnectError = (err) => {
    const code = err.response?.data?.error?.code;
    const message = err.response?.data?.error?.message;
    const serverId = err.response?.data?.error?.serverId || err.response?.data?.error?.details?.serverId;
    if (code === 'VAULT_DISABLED') {
      return { message: message || 'Personal vault has been turned off for your organization.' };
    }
    if (code === 'SECRET_REQUIRED') {
      return { message: message || 'This host needs a password or key for this connection.' };
    }
    if (code && code.includes('PROD')) {
      return {
        message:
          message ||
          'This host matches a production server and connecting to it requires the access-request flow instead.',
        serverId,
      };
    }
    if (code === 'TARGET_NOT_ALLOWED') {
      return { message: message || "This address can't be targeted — loopback, link-local and cloud metadata addresses are blocked." };
    }
    return { message: message || err.message || 'Failed to connect' };
  };

  const handleConnect = async (host) => {
    setConnectError(null);
    if (!host.credential) {
      setAuthTarget(host);
      return;
    }
    setConnectingId(host.id);
    try {
      const resp = await connectVaultHost(host.id, {});
      openTerminalFromTicket(resp, host);
    } catch (err) {
      const code = err.response?.data?.error?.code;
      if (code === 'SECRET_REQUIRED') {
        setAuthTarget(host);
      } else {
        setConnectError(describeConnectError(err));
      }
    } finally {
      setConnectingId(null);
    }
  };

  const handleAuthConnected = (resp) => {
    const host = authTarget;
    setAuthTarget(null);
    if (host) openTerminalFromTicket(resp, host);
  };

  const handleResetHostKey = async () => {
    if (!resetTarget) return;
    setResetting(true);
    try {
      await resetVaultHostKey(resetTarget.id);
      setResetTarget(null);
      fetchHosts();
    } catch (err) {
      setConnectError({ message: err.response?.data?.error?.message || err.message || 'Failed to reset host key' });
      setResetTarget(null);
    } finally {
      setResetting(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    setDeleteError('');
    try {
      await deleteVaultHost(deleteTarget.id);
      setDeleteTarget(null);
      fetchHosts();
    } catch (err) {
      setDeleteError(err.response?.data?.error?.message || err.message || 'Failed to delete host');
    } finally {
      setDeleting(false);
    }
  };

  const columns = [
    {
      key: 'name',
      label: 'Name',
      sortable: true,
      searchAccessor: (r) => `${r.name} ${r.host} ${r.username || ''} ${r.credential?.username || ''}`,
      render: (r) => (
        <div>
          <span className="flex items-center gap-1.5 font-medium text-foreground">
            {r.name}
            <Lock className="h-3 w-3 shrink-0 text-muted-foreground" aria-label="Private" />
          </span>
          {r.description && (
            <span className="block truncate text-[11px] text-muted-foreground max-w-xs">{r.description}</span>
          )}
        </div>
      ),
    },
    {
      key: 'host',
      label: 'Host',
      render: (r) => (
        <span className="font-mono text-xs text-muted-foreground">
          {r.host}
          {r.port && r.port !== 22 ? `:${r.port}` : ''}
        </span>
      ),
    },
    {
      key: 'username',
      label: 'Username',
      render: (r) => (
        <span className="font-mono text-xs text-foreground">{r.username || r.credential?.username || '—'}</span>
      ),
    },
    {
      key: 'identity',
      label: 'Identity',
      hideBelow: 'md',
      render: (r) =>
        r.credential ? (
          <span className="flex items-center gap-1.5">
            <span className="truncate text-sm text-foreground">{r.credential.name}</span>
            <ScopeBadge scope={r.credential.scope} />
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">Ask each time</span>
        ),
    },
    {
      key: 'lastConnectedAt',
      label: 'Last connected',
      sortable: true,
      hideBelow: 'lg',
      render: (r) => (
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground" title={formatDateTime(r.lastConnectedAt)}>
          {r.lastConnectedAt ? relativeTime(r.lastConnectedAt) : 'Never'}
          {r.lastStatus && <Badge tone={statusTone(r.lastStatus).tone}>{statusTone(r.lastStatus).label}</Badge>}
        </span>
      ),
    },
    {
      key: 'hostKey',
      label: 'Host key',
      hideBelow: 'lg',
      render: (r) =>
        r.hostKeyFingerprint ? (
          <span
            className="flex items-center gap-1 font-mono text-[11px] text-muted-foreground"
            title={`Pinned ${formatDateTime(r.hostKeyPinnedAt)} — ${r.hostKeyFingerprint}`}
          >
            <ShieldOff className="h-3 w-3 shrink-0" />
            Pinned
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">Not pinned</span>
        ),
    },
    {
      key: 'connect',
      label: '',
      className: 'w-32',
      render: (r) => (
        <Button size="sm" className="gap-1.5" disabled={connectingId === r.id} onClick={() => handleConnect(r)}>
          {connectingId === r.id ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <>
              <TerminalIcon className="h-4 w-4" /> Connect
            </>
          )}
        </Button>
      ),
    },
    {
      key: 'actions',
      label: '',
      className: 'w-10',
      actions: [
        {
          label: 'Edit',
          icon: Pencil,
          onClick: (r) => {
            setEditing(r);
            setFormOpen(true);
          },
        },
        {
          label: 'Reset host key',
          icon: KeyRound,
          hidden: (r) => !r.hostKeyFingerprint,
          onClick: (r) => setResetTarget(r),
        },
        { separator: true },
        {
          label: 'Delete',
          icon: Trash2,
          variant: 'destructive',
          onClick: (r) => {
            setDeleteTarget(r);
            setDeleteError('');
          },
        },
      ],
    },
  ];

  // Org switch is off — the data still exists server-side, it just can't be
  // listed/used from here (docs/personal-vault.md).
  if (status && !status.enabled) {
    return (
      <div className="space-y-6 p-6">
        <PageHeader icon={Lock} title="My hosts" subtitle="A private list of SSH targets only you can see." />
        <EmptyState
          icon={ShieldOff}
          title="Personal vault is turned off"
          description="Your organization has turned off personal identities, keys and My hosts. Ask an admin to turn it back on in Administration → Access rules. Anything you saved before is kept, just hidden until then."
        />
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        icon={Lock}
        title="My hosts"
        subtitle="A private list of SSH targets only you can see."
        helpKey="my-hosts"
        actions={[
          {
            key: 'add',
            label: 'Add host',
            icon: Plus,
            onClick: () => {
              setEditing(null);
              setFormOpen(true);
            },
          },
        ]}
      />

      {(error || connectError) && (
        <div className="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <p>{error || connectError?.message}</p>
            {connectError?.serverId && (
              <button
                type="button"
                onClick={() => navigate(`/servers/${connectError.serverId}`)}
                className="mt-1 text-xs font-medium underline"
              >
                View server details
              </button>
            )}
          </div>
        </div>
      )}

      {!loading && hosts.length === 0 ? (
        <EmptyState
          icon={Lock}
          title="No hosts yet"
          description="My hosts is your own private SSH address book — name, host, username and an identity to connect with. Nobody else, not even admins, can see these entries."
          action={{ label: 'Add host', onClick: () => { setEditing(null); setFormOpen(true); } }}
        />
      ) : (
        <DataTable
          columns={columns}
          data={hosts}
          loading={loading}
          searchPlaceholder="Search your hosts..."
          emptyMessage="No hosts match your search"
        />
      )}

      <HostFormModal
        open={formOpen}
        host={editing}
        status={status}
        onClose={() => {
          setFormOpen(false);
          setEditing(null);
        }}
        onSaved={fetchHosts}
      />

      <HostConnectAuthModal
        open={!!authTarget}
        host={authTarget}
        onClose={() => setAuthTarget(null)}
        onConnected={handleAuthConnected}
      />

      <ConfirmDialog
        open={!!resetTarget}
        title="Reset host key"
        message={`The next connection to "${resetTarget?.name}" will pin whatever host key it presents. Only do this if you know the key actually changed.`}
        confirmLabel={resetting ? 'Resetting…' : 'Reset host key'}
        variant="destructive"
        onConfirm={handleResetHostKey}
        onCancel={() => setResetTarget(null)}
      />

      <ConfirmDialog
        open={!!deleteTarget}
        title="Delete host"
        message={`Remove "${deleteTarget?.name}" from My hosts? This cannot be undone.`}
        confirmLabel={deleting ? 'Deleting...' : 'Delete'}
        variant="destructive"
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />

      {deleteError && (
        <div className="fixed bottom-4 right-4 z-50 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive shadow-lg">
          {deleteError}
        </div>
      )}
    </div>
  );
}

export default MyHosts;
