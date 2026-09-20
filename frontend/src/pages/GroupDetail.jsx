import { useState, useEffect, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Pencil, Trash2, Plus, X, UsersRound, Search, Building2, AlertTriangle } from 'lucide-react';
import Modal from '@/components/shared/Modal';
import ConfirmDialog from '@/components/shared/ConfirmDialog';
import { Badge } from '@/components/ui/badge';
import { roleTone } from '@/lib/badgeTones';
import UserCell from '@/components/shared/UserCell';
import CustomerScopeSelect from '@/components/shared/CustomerScopeSelect';
import PageHeader from '@/components/common/PageHeader';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  getGroup,
  updateGroup,
  updateGroupScope,
  deleteGroup,
  addGroupMember,
  removeGroupMember,
} from '@/services/groupService';
import { listUsers } from '@/services/userService';
import { listCustomers } from '@/services/customerService';
import { useAuth } from '@/context/AuthContext';
import { useBreadcrumbs } from '@/context/BreadcrumbContext';

function GroupDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const canManage = can('groups.manage');
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
    navigate('/admin/groups');
  };

  useBreadcrumbs([
    { label: 'Administration', to: '/admin' },
    { label: 'Groups', to: '/admin/groups' },
    group ? { label: group.name } : null,
  ]);

  const handleRemoveMember = async () => {
    await removeGroupMember(id, confirmRemove.id);
    setConfirmRemove(null);
    fetch();
  };

  if (loading) {
    return (
      <div className="h-8 w-64 animate-pulse rounded bg-muted" />
    );
  }

  if (error || !group) {
    return (
      <div>
        <Button variant="ghost" onClick={() => navigate('/admin/groups')} className="gap-1 px-0 text-muted-foreground">
          <ArrowLeft className="h-4 w-4" /> Back to groups
        </Button>
        <div className="mt-4 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error || 'Group not found'}
        </div>
      </div>
    );
  }

  // Backend returns the relation as `memberships` (each entry has a `user`).
  // Some older code paths used `members`; accept either shape for safety.
  const members = group.memberships || group.members || [];

  return (
    <div className="space-y-6">
      <PageHeader
        back={{ to: '/admin/groups', label: 'Back to groups' }}
        helpKey="groups"
        icon={UsersRound}
        title={group.name}
        subtitle={group.description}
        actions={[
          { key: 'edit', label: 'Edit', icon: Pencil, variant: 'outline', onClick: () => setEditOpen(true), hidden: !canManage },
          { key: 'delete', label: 'Delete', icon: Trash2, variant: 'destructive', onClick: () => setConfirmDelete(true), hidden: !canManage },
        ]}
      />

      <div className="rounded-lg border border-border bg-card">
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <h2 className="text-sm font-semibold text-foreground">
            Members ({members.length})
          </h2>
          {canManage && (
            <Button size="sm" onClick={() => setAddOpen(true)}>
              <Plus className="mr-1.5 h-3.5 w-3.5" /> Add Member
            </Button>
          )}
        </div>
        {members.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted-foreground">No members yet</div>
        ) : (
          <ul className="divide-y divide-border">
            {members.map((m) => {
              const u = m.user || m;
              return (
                <li key={u.id} className="flex items-center justify-between px-5 py-3">
                  <UserCell user={u} />
                  <div className="flex items-center gap-3">
                    {u.role && <Badge tone={roleTone(u.role).tone}>{roleTone(u.role).label}</Badge>}
                    {canManage && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-muted-foreground hover:text-destructive"
                      onClick={() => setConfirmRemove(u)}
                      title="Remove member"
                    >
                      <X className="h-4 w-4" />
                    </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {can('users.assign_scope') && <GroupScopeSection group={group} onSaved={fetch} />}

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

// Sorted-set comparison for two customerId arrays — order doesn't matter.
function sameIds(a = [], b = []) {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

/**
 * GroupScopeSection — customer scope for a group (docs/rbac/customer-scope-spec.md
 * §2.1, §4.4). A group's scope is either "Entire organization" (ALL) or
 * "Selected customers" (CUSTOMERS). For a CUSTOMERS group, membership is
 * additive with each member's own scope: a member whose access scope is
 * "Selected customers" also sees whatever customers their groups carry.
 *
 * An ALL group is different in kind, not degree — it doesn't just add
 * customers, it removes a scoped member's restriction outright for as long
 * as they're in the group. That's surprising enough that it gets its own
 * prominent warning below, not the quiet inline note the CUSTOMERS mode gets.
 *
 * Gated on `users.assign_scope`, same as the user scope editor.
 */
function GroupScopeSection({ group, onSaved }) {
  const [customers, setCustomers] = useState([]);
  const [accessScope, setAccessScope] = useState(group.accessScope || 'ALL');
  const [customerIds, setCustomerIds] = useState(group.customerIds || []);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    listCustomers({ page: 1, pageSize: 200, isActive: true })
      .then((data) => setCustomers(data.items || []))
      .catch(() => setCustomers([]));
  }, []);

  // Re-sync when the group reloads (e.g. after a save elsewhere), but not on
  // every render — only when its id or scope actually changes.
  useEffect(() => {
    setAccessScope(group.accessScope || 'ALL');
    setCustomerIds(group.customerIds || []);
    setDirty(false);
  }, [group.id, group.accessScope, group.customerIds]);

  const handleScopeChange = (next) => {
    setAccessScope(next);
    setDirty(next !== (group.accessScope || 'ALL') || !sameIds(customerIds, group.customerIds || []));
  };

  const handleChange = (ids) => {
    setCustomerIds(ids);
    setDirty(true);
  };

  const handleSave = async () => {
    setSaving(true);
    setError('');
    try {
      await updateGroupScope(group.id, {
        accessScope,
        customerIds: accessScope === 'CUSTOMERS' ? customerIds : [],
      });
      setDirty(false);
      onSaved?.();
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message || 'Failed to update scope');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="border-b border-border px-5 py-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <Building2 className="h-4 w-4 text-muted-foreground" /> Customer scope
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Controls which customers members of this group can see, on top of their own access
          scope.
        </p>
      </div>
      <div className="space-y-3 p-5">
        {error && (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        <div className="flex gap-1 rounded-md border border-border p-1" role="tablist" aria-label="Group access scope">
          <button
            type="button"
            role="tab"
            aria-selected={accessScope === 'ALL'}
            onClick={() => handleScopeChange('ALL')}
            className={`flex-1 rounded px-2 py-1.5 text-xs font-medium ${
              accessScope === 'ALL' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'
            }`}
          >
            Entire organization
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={accessScope === 'CUSTOMERS'}
            onClick={() => handleScopeChange('CUSTOMERS')}
            className={`flex-1 rounded px-2 py-1.5 text-xs font-medium ${
              accessScope === 'CUSTOMERS' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'
            }`}
          >
            Selected customers
          </button>
        </div>

        {accessScope === 'ALL' ? (
          <div className="flex items-start gap-2.5 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2.5 text-destructive">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <div className="space-y-0.5">
              <p className="text-sm font-semibold">This removes members&apos; restrictions — it doesn&apos;t just add access</p>
              <p className="text-xs text-destructive/90">
                Every member of this group becomes unrestricted and can see the entire
                organization for as long as they&apos;re in it — including members whose own
                access scope is set to “Selected customers.” Putting someone in this group is
                the same as clearing their personal restriction; removing them from it restores
                that restriction.
              </p>
            </div>
          </div>
        ) : (
          <CustomerScopeSelect
            customers={customers}
            value={customerIds}
            onChange={handleChange}
            warning="No customers selected — this group grants no additional customers to its members."
          />
        )}

        <div className="flex justify-end">
          <Button size="sm" onClick={handleSave} disabled={!dirty || saving}>
            {saving ? 'Saving...' : 'Save scope'}
          </Button>
        </div>
      </div>
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

  return (
    <Modal open={open} onClose={onClose} title="Edit group">
      <form onSubmit={submit} className="space-y-4">
        {error && (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}
        <div>
          <label className="mb-1.5 block text-sm font-medium text-foreground">Name <span className="text-destructive">*</span></label>
          <Input value={name} onChange={(e) => setName(e.target.value)} required />
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
        <div data-sheet-footer className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={submitting}>
            {submitting ? 'Saving...' : 'Save changes'}
          </Button>
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
    <Modal open={open} onClose={onClose} title="Add member">
      <div className="space-y-3">
        {error && (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search users..."
            className="pl-9"
          />
        </div>
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
                    <UserCell user={u} />
                    <Button
                      size="sm"
                      onClick={() => handleAdd(u)}
                      disabled={isMember || addingId === u.id}
                    >
                      {isMember ? 'Member' : addingId === u.id ? 'Adding...' : 'Add'}
                    </Button>
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
