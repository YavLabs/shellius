import { useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Plus,
  KeyRound,
  Pencil,
  UserX,
  Trash2,
  Users as UsersIcon,
  Mail,
  RotateCcw,
  Copy,
  Check,
  Lock,
  Unlock,
  ShieldCheck,
  LogOut,
  Fingerprint,
} from 'lucide-react';
import DataTable from '@/components/shared/DataTable';
import { Badge } from '@/components/ui/badge';
import { roleTone, statusTone } from '@/lib/badgeTones';
import UserCell from '@/components/shared/UserCell';
import Modal from '@/components/shared/Modal';
import ConfirmDialog from '@/components/shared/ConfirmDialog';
import DeleteUserDialog from '@/components/users/DeleteUserDialog';
import UserForm from '@/components/users/UserForm';
import SshKeyDialog from '@/components/users/SshKeyDialog';
import UserSignInMethods from '@/components/users/UserSignInMethods';
import PageHeader from '@/components/common/PageHeader';
import { formatLabel } from '@/utils/format';
import { ROLE_LABELS, USER_STATUS_LABELS } from '@/lib/labels';
import { Button } from '@/components/ui/button';
import SearchableSelect from '@/components/ui/SearchableSelect';
import {
  listUsers,
  createUser,
  updateUser,
  uploadSshKey,
  removeSshKey,
  getUser,
  resendInvite,
  triggerPasswordReset,
  unlockUser,
  revokeUserSessions,
} from '@/services/userService';
import { listRoles } from '@/services/roleService';
import { useAuth } from '@/context/AuthContext';

const STATUSES = ['active', 'invited', 'suspended', 'deactivated'];

function isLocked(u) {
  return !!u.lockedUntil && new Date(u.lockedUntil).getTime() > Date.now();
}

function formatDate(d) {
  if (!d) return '-';
  try {
    const dt = new Date(d);
    return dt.toLocaleDateString() + ' ' + dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '-';
  }
}

function CopyUrlButton({ url }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* ignore */ }
  };
  return (
    <button
      onClick={handleCopy}
      className="ml-2 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded border border-input bg-background text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
      title="Copy to clipboard"
    >
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  );
}

function Users() {
  const [users, setUsers] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [role, setRole] = useState('');
  const [status, setStatus] = useState('');

  const { user: me, can } = useAuth();
  const [roles, setRoles] = useState([]);
  useEffect(() => {
    listRoles()
      .then(setRoles)
      .catch(() => setRoles([]));
  }, []);
  const assignableRoleIds = new Set(roles.filter((r) => r.assignable).map((r) => r.id));
  const isMe = (r) => r.id === me?.id;
  // You can manage yourself, and anyone whose role you could assign.
  const manageable = (r) => isMe(r) || assignableRoleIds.has(r.roleId);

  const [formOpen, setFormOpen] = useState(false);
  const [editingUser, setEditingUser] = useState(null);

  const [sshOpen, setSshOpen] = useState(false);
  const [sshUser, setSshUser] = useState(null);

  const [confirm, setConfirm] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);

  const [urlModal, setUrlModal] = useState(null);
  const [signInUser, setSignInUser] = useState(null);
  const [actionMsg, setActionMsg] = useState('');
  const [searchParams, setSearchParams] = useSearchParams();

  // Deep links: /admin/users?action=invite opens the invite modal; ?highlight=<id>
  // opens that user's edit modal (no inline row-highlight affordance in
  // DataTable, so this is the closest equivalent).
  useEffect(() => {
    const action = searchParams.get('action');
    const highlightId = searchParams.get('highlight');
    if (action === 'invite') {
      setEditingUser(null);
      setFormOpen(true);
    } else if (highlightId) {
      getUser(highlightId)
        .then((u) => {
          if (u) {
            setEditingUser(u);
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
  }, []);

  const fetchUsers = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = { page, pageSize };
      if (role) params.roleId = role;
      if (status) params.status = status;
      const data = await listUsers(params);
      setUsers(data.items || []);
      setTotal(data.total || 0);
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message || 'Failed to load users');
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, role, status]);

  useEffect(() => {
    fetchUsers();
  }, [fetchUsers]);

  const openCreate = () => { setEditingUser(null); setFormOpen(true); };
  const openEdit = (u) => { setEditingUser(u); setFormOpen(true); };

  const handleSubmit = async (payload) => {
    if (editingUser) {
      await updateUser(editingUser.id, payload);
    } else {
      await createUser(payload);
    }
    setFormOpen(false);
    setEditingUser(null);
    fetchUsers();
  };

  const openSsh = async (u) => {
    try {
      const full = await getUser(u.id);
      setSshUser(full || u);
    } catch {
      setSshUser(u);
    }
    setSshOpen(true);
  };

  const handleSaveSshKey = async (publicKey) => {
    await uploadSshKey(sshUser.id, publicKey);
    setSshOpen(false);
    setSshUser(null);
    fetchUsers();
  };

  const handleRemoveSshKey = async () => {
    await removeSshKey(sshUser.id);
    setSshOpen(false);
    setSshUser(null);
    fetchUsers();
  };

  const handleDeactivate = (u) => {
    setConfirm({
      title: 'Deactivate user',
      message: `Deactivate ${u.name}? They will not be able to sign in.`,
      variant: 'default',
      confirmLabel: 'Deactivate',
      onConfirm: async () => {
        await updateUser(u.id, { status: 'deactivated' });
        setConfirm(null);
        fetchUsers();
      },
    });
  };

  const handleDelete = (u) => setDeleteTarget(u);

  const handleUnlock = (u) => {
    setConfirm({
      title: 'Unlock account',
      message: `Clear the failed-login lockout for ${u.name}? They'll be able to sign in immediately.`,
      variant: 'default',
      confirmLabel: 'Unlock',
      onConfirm: async () => {
        await unlockUser(u.id);
        setConfirm(null);
        fetchUsers();
      },
    });
  };

  const handleRevokeSessions = (u) => {
    setConfirm({
      title: 'Sign out all sessions',
      message: `Sign ${u.name} out of every device and application? Their next request will require signing in again.`,
      variant: 'destructive',
      confirmLabel: 'Sign out everywhere',
      onConfirm: async () => {
        await revokeUserSessions(u.id);
        setConfirm(null);
        fetchUsers();
      },
    });
  };

  const handleResendInvite = async (u) => {
    try {
      const result = await resendInvite(u.id);
      if (result?.inviteUrl) {
        setUrlModal({ title: 'Invite URL (SMTP unavailable)', url: result.inviteUrl });
      } else {
        setActionMsg(`Invite resent to ${u.email}.`);
        setTimeout(() => setActionMsg(''), 4000);
      }
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message || 'Failed to resend invite.');
    }
  };

  const handleTriggerPasswordReset = async (u) => {
    try {
      const result = await triggerPasswordReset(u.id);
      if (result?.resetUrl) {
        setUrlModal({ title: 'Password Reset URL (SMTP unavailable)', url: result.resetUrl });
      } else {
        setActionMsg(`Password reset email sent to ${u.email}.`);
        setTimeout(() => setActionMsg(''), 4000);
      }
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message || 'Failed to send password reset.');
    }
  };

  const filterSlot = (
    <>
      <SearchableSelect
        className="w-[160px]"
        value={role}
        onChange={(v) => { setRole(v); setPage(1); }}
        options={[
          { value: '', label: 'All roles' },
          ...roles.map((r) => ({ value: r.id, label: r.name })),
        ]}
        placeholder="All roles"
        searchable={false}
        clearable={false}
      />
      <SearchableSelect
        className="w-[160px]"
        value={status}
        onChange={(v) => { setStatus(v); setPage(1); }}
        options={[
          { value: '', label: 'All statuses' },
          ...STATUSES.map((s) => ({ value: s, label: USER_STATUS_LABELS[s] || formatLabel(s) })),
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
      searchAccessor: (r) => `${r.name || ''} ${r.email || ''}`,
      render: (r) => <UserCell user={r} />,
    },
    {
      key: 'role',
      label: 'Role',
      sortable: true,
      searchAccessor: (r) => r.roleInfo?.name || r.role || '',
      render: (r) => (
        <Badge tone={roleTone(r.role).tone}>{r.roleInfo?.name || roleTone(r.role).label}</Badge>
      ),
    },
    {
      key: 'status',
      label: 'Status',
      sortable: true,
      searchAccessor: (r) => r.status || '',
      render: (r) => (
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tone={statusTone(r.status).tone}>{statusTone(r.status).label}</Badge>
          {isLocked(r) && (
            <Badge tone="danger" icon={Lock}>
              Locked
            </Badge>
          )}
        </div>
      ),
    },
    {
      key: 'mfa',
      label: 'MFA',
      hideBelow: 'md',
      render: (r) =>
        r.mfaEnabled ? (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-600 dark:text-emerald-400">
            <ShieldCheck className="h-3.5 w-3.5" /> Enabled
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">&mdash;</span>
        ),
    },
    {
      key: 'manager',
      label: 'Manager',
      hideBelow: 'md',
      render: (r) => <span className="text-muted-foreground">{r.manager?.name || '-'}</span>,
    },
    {
      key: 'lastLogin',
      label: 'Last login',
      hideBelow: 'lg',
      render: (r) => <span className="text-muted-foreground">{formatDate(r.lastLoginAt || r.lastLogin)}</span>,
    },
    {
      key: 'actions',
      label: '',
      className: 'w-10',
      actions: [
        // Each action: its permission AND the right to manage this user
        // (you can only act on users whose role you could assign).
        {
          label: 'Edit',
          icon: Pencil,
          hidden: (r) => !manageable(r) || !(can('users.update') || can('users.assign_role') || can('users.suspend')),
          onClick: (r) => openEdit(r),
        },
        { label: 'Upload SSH Key', icon: KeyRound, hidden: (r) => !manageable(r) || !can('users.update'), onClick: (r) => openSsh(r) },
        {
          label: 'Sign-in methods',
          icon: Fingerprint,
          hidden: (r) => !manageable(r) || !can('users.manage_identities'),
          onClick: (r) => setSignInUser(r),
        },
        {
          label: 'Resend invite',
          icon: Mail,
          hidden: (r) => r.status !== 'invited' || !manageable(r) || !can('users.invite'),
          onClick: (r) => handleResendInvite(r),
        },
        {
          label: 'Send password reset',
          icon: RotateCcw,
          hidden: (r) => r.status !== 'active' || isMe(r) || !manageable(r) || !can('users.reset_credentials'),
          onClick: (r) => handleTriggerPasswordReset(r),
        },
        {
          label: 'Unlock account',
          icon: Unlock,
          hidden: (r) => !isLocked(r) || !manageable(r) || !can('users.reset_credentials'),
          onClick: (r) => handleUnlock(r),
        },
        {
          label: 'Sign out all sessions',
          icon: LogOut,
          hidden: (r) => !manageable(r) || !can('users.revoke_sessions'),
          onClick: (r) => handleRevokeSessions(r),
        },
        {
          label: 'Deactivate',
          icon: UserX,
          hidden: (r) => isMe(r) || !manageable(r) || !can('users.suspend'),
          onClick: (r) => handleDeactivate(r),
        },
        { separator: true, hidden: (r) => isMe(r) || !manageable(r) || !can('users.delete') },
        {
          label: 'Delete',
          icon: Trash2,
          variant: 'destructive',
          hidden: (r) => isMe(r) || !manageable(r) || !can('users.delete'),
          onClick: (r) => handleDelete(r),
        },
      ],
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader icon={UsersIcon} title="Users" subtitle="Manage user accounts, roles, and access." helpKey="users">
        {can('users.invite') && (
          <Button onClick={openCreate}>
            <Plus className="mr-2 h-4 w-4" /> Add User
          </Button>
        )}
      </PageHeader>

      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {actionMsg && (
        <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300">
          {actionMsg}
        </div>
      )}

      <DataTable
        columns={columns}
        data={users}
        loading={loading}
        emptyMessage="No users found"
        searchPlaceholder="Search by name or email..."
        filters={filterSlot}
        serverPagination={{
          page,
          total,
          onPageChange: setPage,
          pageSize,
          onPageSizeChange: (size) => { setPageSize(size); setPage(1); },
        }}
      />

      <Modal
        open={formOpen}
        onClose={() => { setFormOpen(false); setEditingUser(null); }}
        title={editingUser ? 'Edit User' : 'Add User'}
      >
        <UserForm
          user={editingUser}
          onSubmit={handleSubmit}
          onCancel={() => { setFormOpen(false); setEditingUser(null); }}
        />
      </Modal>

      <Modal
        open={sshOpen}
        onClose={() => { setSshOpen(false); setSshUser(null); }}
        title={`SSH Key — ${sshUser?.name || ''}`}
      >
        {sshUser && (
          <SshKeyDialog
            user={sshUser}
            onSave={handleSaveSshKey}
            onRemove={handleRemoveSshKey}
            onCancel={() => { setSshOpen(false); setSshUser(null); }}
          />
        )}
      </Modal>

      <Modal
        open={!!signInUser}
        onClose={() => setSignInUser(null)}
        title="Sign-in methods"
        size="md"
      >
        {signInUser && <UserSignInMethods user={signInUser} onClose={() => setSignInUser(null)} />}
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

      <DeleteUserDialog
        user={deleteTarget}
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onDeleted={() => {
          setDeleteTarget(null);
          fetchUsers();
        }}
      />

      <Modal
        open={!!urlModal}
        onClose={() => setUrlModal(null)}
        title={urlModal?.title || 'Link'}
        size="md"
      >
        {urlModal && (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              SMTP is unavailable. Copy the link below and share it with the user directly.
            </p>
            <div className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2">
              <span className="flex-1 break-all font-mono text-xs text-foreground">{urlModal.url}</span>
              <CopyUrlButton url={urlModal.url} />
            </div>
            <div data-sheet-footer className="flex justify-end">
              <Button variant="outline" size="sm" onClick={() => setUrlModal(null)}>Close</Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

export default Users;
