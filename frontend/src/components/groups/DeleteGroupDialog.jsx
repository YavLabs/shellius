import { useEffect, useState } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import Modal from '@/components/shared/Modal';
import { Button } from '@/components/ui/button';
import { getGroupDeleteImpact, deleteGroup } from '@/services/groupService';

/**
 * DeleteGroupDialog — hard-delete with an impact summary. Members are removed
 * (cascade) and the group is removed from any policies that reference it as a
 * subject; warns about policies that would be left with no subjects.
 */
export default function DeleteGroupDialog({ group, open, onClose, onDeleted }) {
  const [impact, setImpact] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open || !group?.id) return undefined;
    let cancelled = false;
    setLoading(true);
    setError('');
    setImpact(null);
    getGroupDeleteImpact(group.id)
      .then((imp) => !cancelled && setImpact(imp))
      .catch((e) => !cancelled && setError(e.response?.data?.error?.message || 'Failed to load impact'))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [open, group?.id]);

  const handleDelete = async () => {
    setBusy(true);
    setError('');
    try {
      await deleteGroup(group.id);
      onDeleted?.();
    } catch (e) {
      setError(e.response?.data?.error?.message || 'Delete failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={`Delete ${group?.name || 'group'}`}>
      {loading ? (
        <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Checking dependencies…
        </div>
      ) : (
        <div className="space-y-4">
          {error && (
            <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}

          <p className="text-sm text-foreground">Deleting this group will:</p>
          <ul className="space-y-1.5 text-sm text-muted-foreground">
            <li>
              Remove <span className="font-medium text-foreground">{impact?.memberCount ?? 0}</span> member(s)
              from the group (the users themselves are not deleted)
            </li>
            {impact?.policyCount > 0 && (
              <li>
                Remove this group from <span className="font-medium text-foreground">{impact.policyCount}</span>{' '}
                policy(ies) it grants access through
              </li>
            )}
          </ul>

          {impact?.policiesLeftEmpty > 0 && (
            <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
              <AlertTriangle className="mr-1 inline h-3.5 w-3.5" />
              {impact.policiesLeftEmpty} policy(ies) will have no subjects left and grant access to no one
              until you add a subject.
            </div>
          )}

          {impact?.policies?.length > 0 && (
            <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
              Affected policies: {impact.policies.map((p) => p.name).join(', ')}
            </div>
          )}

          <p className="text-xs text-muted-foreground">This action cannot be undone.</p>

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={busy}>
              {busy ? 'Deleting…' : 'Delete group'}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
