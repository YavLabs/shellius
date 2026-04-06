import { useState, useEffect, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Pencil, Trash2, Plus, X, UsersRound } from 'lucide-react';
import Modal from '@/components/shared/Modal';
import ConfirmDialog from '@/components/shared/ConfirmDialog';
import Badge from '@/components/shared/Badge';
import SearchInput from '@/components/shared/SearchInput';
import {
  getGroup,
  updateGroup,
  deleteGroup,
  addGroupMember,
  removeGroupMember,
} from '@/services/groupService';
import { listUsers } from '@/services/userService';

function GroupDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [group, setGroup] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [editOpen, setEditOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(null);

  const fetch = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await getGroup(id);
      setGroup(data);
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message || 'Failed to load group');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { fetch(); }, [fetch]);

  const handleDelete = async () => {
    await deleteGroup(id);
    navigate('/groups');
  };

  const handleRemoveMember = async () => {
    await removeGroupMember(id, confirmRemove.id);
    setConfirmRemove(null);
    fetch();
  };

  if (loading) {
    return (
      <div className="p-6">
        <div className="h-8 w-64 animate-pulse rounded bg-muted" />
      </div>
    );
  }

  if (error || !group) {
    return (
      <div className="p-6">
        <button
          onClick={() => navigate('/groups')}
          className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" /> Back to groups
        </button>
        <div className="mt-4 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error || 'Group not found'}
        </div>
      </div>
    );
  }

  const members = group.members || [];

  return (
    <div className="space-y-5 p-6">
      <button
        onClick={() => navigate('/groups')}
        className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" /> Back to groups
      </button>

      <div className="flex items-start justify-between">
        <div className="flex items-start gap-4">
          <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <UsersRound className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-foreground">{group.name}</h1>
            {group.description && (
              <p className="mt-1 text-sm text-muted-foreground">{group.description}</p>
            )}
          </div>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setEditOpen(true)}
            className="flex h-9 items-center gap-1.5 rounded-md border border-input bg-background px-3 text-sm font-medium text-foreground hover:bg-accent"
          >
            <Pencil className="h-4 w-4" /> Edit
          </button>
          <button
            onClick={() => setConfirmDelete(true)}
            className="flex h-9 items-center gap-1.5 rounded-md border border-destructive/50 bg-background px-3 text-sm font-medium text-destructive hover:bg-destructive/10"
          >
            <Trash2 className="h-4 w-4" /> Delete
          </button>
        </div>
      </div>

      <div className="rounded-lg border border-border bg-card">
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <h2 className="text-sm font-semibold text-foreground">
            Members ({members.length})
          </h2>
          <button
            onClick={() => setAddOpen(true)}
            className="flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            <Plus className="h-3.5 w-3.5" /> Add Member
          </button>
        </div>
        {members.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted-foreground">No members yet</div>
        ) : (
          <ul className="divide-y divide-border">
            {members.map((m) => {
              const u = m.user || m;
              return (
                <li key={u.id} className="flex items-center justify-between px-5 py-3">
                  <div className="flex items-center gap-3">
                    <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary text-xs font-medium text-primary-foreground">
                      {u.name?.[0]?.toUpperCase() || 'U'}
                    </div>
                    <div>
                      <p className="text-sm font-medium text-foreground">{u.name}</p>
                      <p className="text-xs text-muted-foreground">{u.email}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    {u.role && <Badge variant="info">{u.role}</Badge>}
                    <button
                      onClick={() => setConfirmRemove(u)}
                      className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-destructive"
                      title="Remove member"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <EditGroupModal
        open={editOpen}
        group={group}
        onClose={() => setEditOpen(false)}
        onSaved={() => { setEditOpen(false); fetch(); }}
      />

      <AddMemberModal
        open={addOpen}
        groupId={id}
        existingIds={members.map((m) => (m.user || m).id)}
        onClose={() => setAddOpen(false)}
        onAdded={() => { setAddOpen(false); fetch(); }}
      />

      <ConfirmDialog
        open={confirmDelete}
        title="Delete group"
        message={`Permanently delete "${group.name}"? This cannot be undone.`}
        confirmLabel="Delete"
        variant="destructive"
        onConfirm={handleDelete}
        onCancel={() => setConfirmDelete(false)}
      />

      <ConfirmDialog
        open={!!confirmRemove}
        title="Remove member"
        message={`Remove ${confirmRemove?.name} from this group?`}
        confirmLabel="Remove"
        variant="destructive"
        onConfirm={handleRemoveMember}
        onCancel={() => setConfirmRemove(null)}
      />
    </div>
  );
}

function EditGroupModal({ open, group, onClose, onSaved }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open && group) {
      setName(group.name || '');
      setDescription(group.description || '');
      setError('');
    }
  }, [open, group]);

  const submit = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      await updateGroup(group.id, { name: name.trim(), description: description.trim() });
      onSaved();
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message || 'Failed to update');
    } finally {
      setSubmitting(false);
    }
  };

  const inputCls =
    'h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring';

  return (
    <Modal open={open} onClose={onClose} title="Edit Group">
      <form onSubmit={submit} className="space-y-4">
        {error && (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}
        <div>
          <label className="mb-1.5 block text-sm font-medium text-foreground">Name</label>
          <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} required />
        </div>
        <div>
          <label className="mb-1.5 block text-sm font-medium text-foreground">Description</label>
          <textarea
            rows={3}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="h-9 rounded-md border border-input bg-background px-4 text-sm font-medium text-foreground hover:bg-accent"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="h-9 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {submitting ? 'Saving...' : 'Save changes'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function AddMemberModal({ open, groupId, existingIds, onClose, onAdded }) {
  const [search, setSearch] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [addingId, setAddingId] = useState(null);

  useEffect(() => {
    if (!open) return;
    setSearch('');
    setError('');
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const data = await listUsers({ page: 1, pageSize: 20, search: search || undefined });
        if (!cancelled) setResults(data.items || []);
      } catch (err) {
        if (!cancelled) setError(err.response?.data?.error?.message || 'Failed to search users');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [search, open]);

  const handleAdd = async (user) => {
    setAddingId(user.id);
    try {
      await addGroupMember(groupId, user.id);
      onAdded();
    } catch (err) {
      setError(err.response?.data?.error?.message || 'Failed to add member');
    } finally {
      setAddingId(null);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Add Member">
      <div className="space-y-3">
        {error && (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}
        <SearchInput value={search} onChange={setSearch} placeholder="Search users..." />
        <div className="max-h-80 overflow-y-auto rounded-md border border-border">
          {loading ? (
            <div className="p-4 text-center text-sm text-muted-foreground">Loading...</div>
          ) : results.length === 0 ? (
            <div className="p-4 text-center text-sm text-muted-foreground">No users found</div>
          ) : (
            <ul className="divide-y divide-border">
              {results.map((u) => {
                const isMember = existingIds.includes(u.id);
                return (
                  <li key={u.id} className="flex items-center justify-between px-4 py-2.5">
                    <div>
                      <p className="text-sm font-medium text-foreground">{u.name}</p>
                      <p className="text-xs text-muted-foreground">{u.email}</p>
                    </div>
                    <button
                      onClick={() => handleAdd(u)}
                      disabled={isMember || addingId === u.id}
                      className="h-8 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {isMember ? 'Member' : addingId === u.id ? 'Adding...' : 'Add'}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </Modal>
  );
}

export default GroupDetail;
