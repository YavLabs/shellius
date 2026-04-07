import { useState, useEffect, useCallback } from 'react';
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
} from 'lucide-react';
import DataTable from '@/components/shared/DataTable';
import Badge from '@/components/shared/Badge';
import Modal from '@/components/shared/Modal';
import ConfirmDialog from '@/components/shared/ConfirmDialog';
import UserForm from '@/components/users/UserForm';
import SshKeyDialog from '@/components/users/SshKeyDialog';
import PageHeader from '@/components/common/PageHeader';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  listUsers,
  createUser,
  updateUser,
  deleteUser,
  uploadSshKey,
  removeSshKey,
  getUser,
  resendInvite,
  triggerPasswordReset,
} from '@/services/userService';

const ROLES = ['super_admin', 'admin', 'operator', 'viewer'];
const STATUSES = ['active', 'invited', 'suspended', 'deactivated'];

const roleVariant = (role) => {
  switch (role) {
    case 'super_admin': return 'danger';
    case 'admin': return 'info';
    case 'operator': return 'warning';
    default: return 'default';
  }
};

const statusVariant = (status) => {
  switch (status) {
    case 'active': return 'success';
    case 'invited': return 'info';
    case 'suspended': return 'warning';
    case 'deactivated': return 'danger';
    default: return 'default';
  }
};

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
  const [pageSize] = useState(20);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [role, setRole] = useState('');
  const [status, setStatus] = useState('');

  const [formOpen, setFormOpen] = useState(false);
  const [editingUser, setEditingUser] = useState(null);

  const [sshOpen, setSshOpen] = useState(false);
  const [sshUser, setSshUser] = useState(null);

  const [confirm, setConfirm] = useState(null);

  const [urlModal, setUrlModal] = useState(null);
  const [actionMsg, setActionMsg] = useState('');

  const fetchUsers = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = { page, pageSize };
      if (role) params.role = role;
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

  const handleDelete = (u) => {
    setConfirm({
      title: 'Delete user',
      message: `Permanently delete ${u.name}? This cannot be undone.`,
      variant: 'destructive',
      confirmLabel: 'Delete',
      onConfirm: async () => {
        await deleteUser(u.id);
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
      <Select value={role || '_all'} onValueChange={(v) => { setRole(v === '_all' ? '' : v); setPage(1); }}>
        <SelectTrigger className="w-[160px]"><SelectValue placeholder="All roles" /></SelectTrigger>
        <SelectContent>
          <SelectItem value="_all">All roles</SelectItem>
          {ROLES.map((r) => <SelectItem key={r} value={r}>{r}</SelectItem>)}
        </SelectContent>
      </Select>
      <Select value={status || '_all'} onValueChange={(v) => { setStatus(v === '_all' ? '' : v); setPage(1); }}>
        <SelectTrigger className="w-[160px]"><SelectValue placeholder="All statuses" /></SelectTrigger>
        <SelectContent>
          <SelectItem value="_all">All statuses</SelectItem>
          {STATUSES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
        </SelectContent>
      </Select>
    </>
  );

  const columns = [
    {
      key: 'name',
      label: 'Name',
      sortable: true,
      render: (r) => <span className="font-medium">{r.name}</span>,
    },
    {
      key: 'email',
      label: 'Email',
      sortable: true,
      render: (r) => <span className="text-muted-foreground">{r.email}</span>,
    },
    {
      key: 'role',
      label: 'Role',
      sortable: true,
      searchAccessor: (r) => r.role || '',
      render: (r) => <Badge variant={roleVariant(r.role)}>{r.role}</Badge>,
    },
    {
      key: 'status',
      label: 'Status',
      sortable: true,
      searchAccessor: (r) => r.status || '',
      render: (r) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge>,
    },
    {
      key: 'manager',
      label: 'Manager',
      hideBelow: 'md',
      render: (r) => <span className="text-muted-foreground">{r.manager?.name || '-'}</span>,
    },
    {
      key: 'lastLogin',
      label: 'Last Login',
      hideBelow: 'lg',
      render: (r) => <span className="text-muted-foreground">{formatDate(r.lastLoginAt || r.lastLogin)}</span>,
    },
    {
      key: 'actions',
      label: '',
      className: 'w-10',
      actions: [
        { label: 'Edit', icon: Pencil, onClick: (r) => openEdit(r) },
        { label: 'Upload SSH Key', icon: KeyRound, onClick: (r) => openSsh(r) },
        { label: 'Resend Invite', icon: Mail, onClick: (r) => handleResendInvite(r) },
        { label: 'Send Password Reset', icon: RotateCcw, onClick: (r) => handleTriggerPasswordReset(r) },
        { label: 'Deactivate', icon: UserX, onClick: (r) => handleDeactivate(r) },
        { separator: true },
        { label: 'Delete', icon: Trash2, variant: 'destructive', onClick: (r) => handleDelete(r) },
      ],
    },
  ];

  return (
    <div className="space-y-6 p-6">
      <PageHeader icon={UsersIcon} title="Users" subtitle="Manage user accounts, roles, and access.">
        <Button onClick={openCreate}>
          <Plus className="mr-2 h-4 w-4" /> Add User
        </Button>
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
        serverPagination={{ page, total, onPageChange: setPage }}
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

      <ConfirmDialog
        open={!!confirm}
        title={confirm?.title}
        message={confirm?.message}
        confirmLabel={confirm?.confirmLabel}
        variant={confirm?.variant}
        onConfirm={confirm?.onConfirm}
        onCancel={() => setConfirm(null)}
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
            <div className="flex justify-end">
              <Button variant="outline" size="sm" onClick={() => setUrlModal(null)}>Close</Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

export default Users;
