import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, UsersRound, Trash2, Pencil } from 'lucide-react';
import Modal from '@/components/shared/Modal';
import ConfirmDialog from '@/components/shared/ConfirmDialog';
import DeleteGroupDialog from '@/components/groups/DeleteGroupDialog';
import DataTable from '@/components/shared/DataTable';
import PageHeader from '@/components/common/PageHeader';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { listGroups, createGroup } from '@/services/groupService';
import { relativeTime } from '@/utils/time';

function Groups() {
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [confirm, setConfirm] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const navigate = useNavigate();

  const fetch = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await listGroups();
      setGroups(Array.isArray(data) ? data : data?.groups || data?.items || []);
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message || 'Failed to load groups');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetch();
  }, [fetch]);

  const handleDelete = (g) => setDeleteTarget(g);

  const columns = [
    {
      key: 'name',
      label: 'Name',
      sortable: true,
      render: (g) => (
        <button
          onClick={() => navigate(`/groups/${g.id}`)}
          className="flex items-center gap-2 font-medium text-foreground hover:text-primary"
        >
          <UsersRound className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          {g.name}
        </button>
      ),
    },
    {
      key: 'description',
      label: 'Description',
      hideBelow: 'md',
      render: (g) => (
        <span className="text-sm text-muted-foreground line-clamp-1">{g.description || '—'}</span>
      ),
    },
    {
      key: 'members',
      label: 'Members',
      sortable: true,
      searchAccessor: (g) => String(g._count?.memberships ?? g.memberCount ?? 0),
      render: (g) => (
        <span className="text-sm text-foreground">
          {g._count?.memberships ?? g.memberCount ?? 0}
        </span>
      ),
    },
    {
      key: 'created',
      label: 'Created',
      sortable: true,
      hideBelow: 'lg',
      render: (g) => (
        <span className="text-xs text-muted-foreground">{relativeTime(g.createdAt)}</span>
      ),
    },
    {
      key: 'actions',
      label: '',
      className: 'w-10',
      actions: [
        {
          label: 'Manage',
          icon: Pencil,
          onClick: (g) => navigate(`/groups/${g.id}`),
        },
        { separator: true },
        {
          label: 'Delete',
          icon: Trash2,
          variant: 'destructive',
          onClick: (g) => handleDelete(g),
        },
      ],
    },
  ];

  return (
    <div className="space-y-6 p-6">
      <PageHeader icon={UsersRound} title="Groups" subtitle="Organize users into access groups." helpKey="groups">
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="mr-2 h-4 w-4" /> Create Group
        </Button>
      </PageHeader>

      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <DataTable
        columns={columns}
        data={groups}
        loading={loading}
        emptyMessage="No groups yet. Create your first one to get started."
        searchPlaceholder="Search groups..."
        onRowClick={(g) => navigate(`/groups/${g.id}`)}
      />

      <CreateGroupModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={() => {
          setCreateOpen(false);
          fetch();
        }}
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

      <DeleteGroupDialog
        group={deleteTarget}
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onDeleted={() => {
          setDeleteTarget(null);
          fetch();
        }}
      />
    </div>
  );
}

function CreateGroupModal({ open, onClose, onCreated }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      setName('');
      setDescription('');
      setError('');
    }
  }, [open]);

  const submit = async (e) => {
    e.preventDefault();
    if (!name.trim()) { setError('Name is required'); return; }
    setSubmitting(true);
    try {
      await createGroup({ name: name.trim(), description: description.trim() });
      onCreated();
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message || 'Failed to create group');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Create Group">
      <form onSubmit={submit} className="space-y-4">
        {error && (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}
        <div>
          <label className="mb-1.5 block text-sm font-medium text-foreground">Name</label>
          <Input value={name} onChange={(e) => setName(e.target.value)} required />
        </div>
        <div>
          <label className="mb-1.5 block text-sm font-medium text-foreground">Description</label>
          <textarea
            rows={3}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={submitting}>
            {submitting ? 'Creating...' : 'Create group'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export default Groups;
