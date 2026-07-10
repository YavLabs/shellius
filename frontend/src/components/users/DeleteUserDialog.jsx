import { useEffect, useState } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import Modal from '@/components/shared/Modal';
import { Button } from '@/components/ui/button';
import SearchableSelect from '@/components/ui/SearchableSelect';
import { getUserDeleteImpact, deleteUser } from '@/services/userService';

/**
 * DeleteUserDialog — hard-delete with an impact summary. Lets the admin reassign
 * the user's direct reports to another manager, blocks the last super_admin, and
 * surfaces what cascades (sessions, requests, memberships, policy references).
 */
export default function DeleteUserDialog({ user, open, onClose, onDeleted }) {
  const [impact, setImpact] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [reassignTo, setReassignTo] = useState('');

  useEffect(() => {
    if (!open || !user?.id) return undefined;
    let cancelled = false;
    setLoading(true);
    setError('');
    setImpact(null);
    setReassignTo('');
    getUserDeleteImpact(user.id)
      .then((imp) => !cancelled && setImpact(imp))
      .catch((e) => !cancelled && setError(e.response?.data?.error?.message || 'Failed to load impact'))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [open, user?.id]);

  const hasReports = impact?.directReportCount > 0;
  const blocked = impact?.isLastSuperAdmin;

  const handleDelete = async () => {
    setBusy(true);
    setError('');
    try {
      const options = {};
      if (hasReports && reassignTo) options.reassignReportsTo = reassignTo;
      await deleteUser(user.id, options);
      onDeleted?.();
    } catch (e) {
      setError(e.response?.data?.error?.message || 'Delete failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={`Delete ${user?.name || 'user'}`}>
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

          {blocked && (
            <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              <AlertTriangle className="mr-1 inline h-3.5 w-3.5" />
              This is the only super_admin in the organization and cannot be deleted.
            </div>
          )}

          {hasReports && !blocked && (
            <div className="space-y-2">
              <p className="text-sm text-foreground">
                <span className="font-medium">{impact.directReportCount}</span> user(s) report to this
                person. Reassign them to another manager?
              </p>
              <SearchableSelect
                value={reassignTo}
                onChange={setReassignTo}
                options={(impact.availableManagers || []).map((m) => ({
                  value: m.id,
                  label: m.name,
                  sublabel: m.email,
                }))}
                placeholder="Leave unmanaged"
                emptyMessage="No other users"
              />
              <p className="text-xs text-muted-foreground">
                Leave empty to clear their manager instead.
              </p>
            </div>
          )}

          <p className="text-sm text-foreground">Deleting this user will:</p>
          <ul className="space-y-1.5 text-sm text-muted-foreground">
            {impact?.activeSessions > 0 && (
              <li className="flex items-center gap-2 text-amber-700 dark:text-amber-400">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                Force-close <span className="font-medium">{impact.activeSessions}</span> live session(s)
              </li>
            )}
            <li>
              Revoke {impact?.activeCertificates ?? 0} active cert(s) and remove{' '}
              {impact?.pendingRequests ?? 0} pending request(s), {impact?.groupMemberships ?? 0} group
              membership(s){impact?.policyReferences > 0 ? `, and ${impact.policyReferences} policy reference(s)` : ''}
            </li>
            <li>Keep audit-log history (the actor link is cleared)</li>
          </ul>
          <p className="text-xs text-muted-foreground">This action cannot be undone.</p>

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={busy || blocked}>
              {busy ? 'Deleting…' : 'Delete user'}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
