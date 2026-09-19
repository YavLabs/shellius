import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import Modal from '@/components/shared/Modal';
import { Button } from '@/components/ui/button';
import SearchableSelect from '@/components/ui/SearchableSelect';
import { deleteRole } from '@/services/roleService';

/**
 * DeleteRoleDialog — deleting a role with users requires moving them to
 * another role first (the API refuses otherwise). Policies that target the
 * role lose that subject; the count is shown before confirming.
 */
function DeleteRoleDialog({ open, onClose, role, roles, policyRefs = 0, onDeleted }) {
  const [target, setTarget] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const userCount = role?.userCount || 0;
  const targets = roles.filter((r) => r.id !== role?.id && r.assignable);

  useEffect(() => {
    if (!open) return;
    setError('');
    setTarget(targets.find((r) => r.key === 'member')?.id || targets[0]?.id || '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, role?.id]);

  if (!role) return null;

  const confirm = async () => {
    setBusy(true);
    setError('');
    try {
      const result = await deleteRole(role.id, userCount > 0 ? { reassignToRoleId: target } : {});
      onDeleted?.(result);
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message || 'Failed to delete role');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={`Delete ${role.name}`} size="sm">
      <div className="space-y-4">
        {error && (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>
        )}
        <p className="text-sm text-muted-foreground">This permanently deletes the role. It can’t be undone.</p>
        {userCount > 0 && (
          <div>
            <label className="mb-1.5 block text-sm font-medium text-foreground">
              Move its {userCount} user{userCount === 1 ? '' : 's'} to
            </label>
            <SearchableSelect
              value={target}
              onChange={setTarget}
              options={targets.map((r) => ({ value: r.id, label: r.name }))}
              searchable={false}
              clearable={false}
            />
          </div>
        )}
        {policyRefs > 0 && (
          <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {policyRefs} access polic{policyRefs === 1 ? 'y targets' : 'ies target'} this role. They’ll stop applying to it.
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" variant="destructive" disabled={busy || (userCount > 0 && !target)} onClick={confirm}>
            {busy ? 'Deleting…' : 'Delete role'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export default DeleteRoleDialog;
