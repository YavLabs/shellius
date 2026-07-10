import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import Modal from '@/components/shared/Modal';
import { Button } from '@/components/ui/button';
import { getPolicyDeleteImpact, deletePolicy } from '@/services/policyService';

/**
 * DeletePolicyDialog — hard-delete with an informational impact summary of who
 * relies on the policy for access (its subjects). The policy's subject rows are
 * removed by cascade.
 */
export default function DeletePolicyDialog({ policy, open, onClose, onDeleted }) {
  const [impact, setImpact] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open || !policy?.id) return undefined;
    let cancelled = false;
    setLoading(true);
    setError('');
    setImpact(null);
    getPolicyDeleteImpact(policy.id)
      .then((imp) => !cancelled && setImpact(imp))
      .catch((e) => !cancelled && setError(e.response?.data?.error?.message || 'Failed to load impact'))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [open, policy?.id]);

  const handleDelete = async () => {
    setBusy(true);
    setError('');
    try {
      await deletePolicy(policy.id);
      onDeleted?.();
    } catch (e) {
      setError(e.response?.data?.error?.message || 'Delete failed');
    } finally {
      setBusy(false);
    }
  };

  const parts = [];
  if (impact?.userCount) parts.push(`${impact.userCount} user(s)`);
  if (impact?.groupCount) parts.push(`${impact.groupCount} group(s)`);
  if (impact?.roleCount) parts.push(`${impact.roleCount} role(s)`);

  return (
    <Modal open={open} onClose={onClose} title={`Delete ${policy?.name || 'policy'}`}>
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

          <p className="text-sm text-foreground">
            {parts.length > 0 ? (
              <>
                This policy grants access to {parts.join(', ')}. They may lose access (unless covered by
                another policy).
              </>
            ) : (
              'This policy has no subjects.'
            )}
          </p>
          {impact?.customer?.name && (
            <p className="text-xs text-muted-foreground">Scoped to customer: {impact.customer.name}</p>
          )}
          <p className="text-xs text-muted-foreground">This action cannot be undone.</p>

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={busy}>
              {busy ? 'Deleting…' : 'Delete policy'}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
