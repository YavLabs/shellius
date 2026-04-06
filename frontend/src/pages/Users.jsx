import { useState, useEffect, useCallback, useRef } from 'react';
import { Plus, MoreVertical, KeyRound, Pencil, UserX, Trash2, ChevronLeft, ChevronRight } from 'lucide-react';
import DataTable from '@/components/shared/DataTable';
import SearchInput from '@/components/shared/SearchInput';
import Badge from '@/components/shared/Badge';
import Modal from '@/components/shared/Modal';
import ConfirmDialog from '@/components/shared/ConfirmDialog';
import UserForm from '@/components/users/UserForm';
import SshKeyDialog from '@/components/users/SshKeyDialog';
import {
  listUsers,
  createUser,
  updateUser,
  deleteUser,
  uploadSshKey,
  removeSshKey,
  getUser,
} from '@/services/userService';

const ROLES = ['', 'super_admin', 'admin', 'operator', 'viewer'];
const STATUSES = ['', 'active', 'invited', 'suspended', 'deactivated'];

const roleVariant = (role) => {
  switch (role) {
    case 'super_admin':
      return 'danger';
    case 'admin':
      return 'info';
    case 'operator':
      return 'warning';
    default:
      return 'default';
  }
};

const statusVariant = (status) => {
  switch (status) {
    case 'active':
      return 'success';
    case 'invited':
      return 'info';
    case 'suspended':
      return 'warning';
    case 'deactivated':
      return 'danger';
    default:
      return 'default';
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

function RowMenu({ onEdit, onSshKey, onDeactivate, onDelete }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    window.addEventListener('mousedown', onClick);
    return () => window.removeEventListener('mousedown', onClick);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((p) => !p)}
        className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <MoreVertical className="h-4 w-4" />
      </button>
      {open && (
        <div className="absolute right-0 z-20 mt-1 w-44 overflow-hidden rounded-md border border-border bg-card shadow-lg">
          <button
            onClick={() => { setOpen(false); onEdit(); }}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-foreground hover:bg-accent"
          >
            <Pencil className="h-3.5 w-3.5" /> Edit
          </button>
          <button
            onClick={() => { setOpen(false); onSshKey(); }}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-foreground hover:bg-accent"
          >
            <KeyRound className="h-3.5 w-3.5" /> Upload SSH Key
          </button>
          <button
            onClick={() => { setOpen(false); onDeactivate(); }}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-foreground hover:bg-accent"
          >
            <UserX className="h-3.5 w-3.5" /> Deactivate
          </button>
          <button
            onClick={() => { setOpen(false); onDelete(); }}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-destructive hover:bg-accent"
          >
            <Trash2 className="h-3.5 w-3.5" /> Delete
          </button>
        </div>
      )}
    </div>
  );
}

function Users() {
  const [users, setUsers] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(20);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [search, setSearch] = useState('');
  const [role, setRole] = useState('');
  const [status, setStatus] = useState('');

  const [formOpen, setFormOpen] = useState(false);
  const [editingUser, setEditingUser] = useState(null);

  const [sshOpen, setSshOpen] = useState(false);
  const [sshUser, setSshUser] = useState(null);

  const [confirm, setConfirm] = useState(null);

  const fetchUsers = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = { page, pageSize };
      if (search) params.search = search;
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
  }, [page, pageSize, search, role, status]);

  useEffect(() => {
    fetchUsers();
  }, [fetchUsers]);

  const openCreate = () => {
    setEditingUser(null);
    setFormOpen(true);
  };

  const openEdit = (user) => {
    setEditingUser(user);
    setFormOpen(true);
  };

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

  const openSsh = async (user) => {
    try {
      const full = await getUser(user.id);
      setSshUser(full || user);
    } catch {
      setSshUser(user);
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

  const handleDeactivate = (user) => {
    setConfirm({
      title: 'Deactivate user',
      message: `Deactivate ${user.name}? They will not be able to sign in.`,
      variant: 'default',
      confirmLabel: 'Deactivate',
      onConfirm: async () => {
        await updateUser(user.id, { status: 'deactivated' });
        setConfirm(null);
        fetchUsers();
      },
    });
  };

  const handleDelete = (user) => {
    setConfirm({
      title: 'Delete user',
      message: `Permanently delete ${user.name}? This cannot be undone.`,
      variant: 'destructive',
      confirmLabel: 'Delete',
      onConfirm: async () => {
        await deleteUser(user.id);
        setConfirm(null);
        fetchUsers();
      },
    });
  };

  const columns = [
    { key: 'name', label: 'Name', render: (r) => <span className="font-medium">{r.name}</span> },
    { key: 'email', label: 'Email', render: (r) => <span className="text-muted-foreground">{r.email}</span> },
    { key: 'role', label: 'Role', render: (r) => <Badge variant={roleVariant(r.role)}>{r.role}</Badge> },
    { key: 'status', label: 'Status', render: (r) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
    { key: 'manager', label: 'Manager', render: (r) => <span className="text-muted-foreground">{r.manager?.name || '-'}</span> },
    { key: 'lastLogin', label: 'Last Login', render: (r) => <span className="text-muted-foreground">{formatDate(r.lastLoginAt || r.lastLogin)}</span> },
    {
      key: 'actions',
      label: '',
      className: 'w-10',
      render: (r) => (
        <RowMenu
          onEdit={() => openEdit(r)}
          onSshKey={() => openSsh(r)}
          onDeactivate={() => handleDeactivate(r)}
          onDelete={() => handleDelete(r)}
        />
      ),
    },
  ];

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const selectCls =
    'h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring';

  return (
    <div className="space-y-5 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Users</h1>
          <p className="text-sm text-muted-foreground">Manage user accounts, roles, and access.</p>
        </div>
        <button
          onClick={openCreate}
          className="flex h-9 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          <Plus className="h-4 w-4" /> Add User
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-64 flex-1">
          <SearchInput value={search} onChange={(v) => { setSearch(v); setPage(1); }} placeholder="Search by name or email..." />
        </div>
        <select className={selectCls} value={role} onChange={(e) => { setRole(e.target.value); setPage(1); }}>
          {ROLES.map((r) => <option key={r} value={r}>{r || 'All roles'}</option>)}
        </select>
        <select className={selectCls} value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
          {STATUSES.map((s) => <option key={s} value={s}>{s || 'All statuses'}</option>)}
        </select>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <DataTable columns={columns} data={users} loading={loading} emptyMessage="No users found" />

      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {total} user{total === 1 ? '' : 's'}
        </p>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1}
            className="flex h-8 items-center gap-1 rounded-md border border-input bg-background px-3 text-sm text-foreground hover:bg-accent disabled:opacity-50"
          >
            <ChevronLeft className="h-4 w-4" /> Previous
          </button>
          <span className="text-sm text-muted-foreground">
            Page {page} of {totalPages}
          </span>
          <button
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page >= totalPages}
            className="flex h-8 items-center gap-1 rounded-md border border-input bg-background px-3 text-sm text-foreground hover:bg-accent disabled:opacity-50"
          >
            Next <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </div>

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
    </div>
  );
}

export default Users;
