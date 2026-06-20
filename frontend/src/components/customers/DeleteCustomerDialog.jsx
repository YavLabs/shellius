import { useEffect, useState } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import Modal from '@/components/shared/Modal';
import { Button } from '@/components/ui/button';
import SearchableSelect from '@/components/ui/SearchableSelect';
import {
  getCustomerDeleteImpact,
  deleteCustomer,
  listCustomers,
} from '@/services/customerService';

/**
 * DeleteCustomerDialog — dependency-aware customer deletion. Surfaces the
 * servers (which cascade-delete by default) and policies scoped to the customer,
 * and lets the user reassign servers to another customer instead of deleting.
 */
export default function DeleteCustomerDialog({ customer, open, onClose, onDeleted }) {
  const [impact, setImpact] = useState(null);
  const [otherCustomers, setOtherCustomers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [serversStrategy, setServersStrategy] = useState('reassign'); // reassign | delete
  const [targetCustomerId, setTargetCustomerId] = useState('');

  useEffect(() => {
    if (!open || !customer?.id) return undefined;
    let cancelled = false;
    setLoading(true);
    setError('');
    setImpact(null);
    setServersStrategy('reassign');
    setTargetCustomerId('');
    Promise.all([
      getCustomerDeleteImpact(customer.id),
      listCustomers({ page: 1, pageSize: 200 }),
    ])
      .then(([imp, list]) => {
        if (cancelled) return;
        setImpact(imp);
        const items = list?.items || list || [];
        setOtherCustomers(items.filter((c) => c.id !== customer.id));
      })
      .catch((e) => !cancelled && setError(e.response?.data?.error?.message || 'Failed to load impact'))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [open, customer?.id]);

  const hasServers = impact?.serverCount > 0;
  const hasPolicies = impact?.policyCount > 0;

  const handleDelete = async () => {
    setBusy(true);
    setError('');
    try {
      const options = {};
      if (hasServers) {
        options.servers = serversStrategy;
        if (serversStrategy === 'reassign') {
          if (!targetCustomerId) {
            setError('Pick a customer to move the servers to.');
            setBusy(false);
            return;
          }
          options.targetCustomerId = targetCustomerId;
        }
      }
      await deleteCustomer(customer.id, options);
      onDeleted?.();
    } catch (e) {
      setError(e.response?.data?.error?.message || 'Delete failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={`Delete ${customer?.name || 'customer'}`}>
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

          {!hasServers && !hasPolicies && (
            <p className="text-sm text-muted-foreground">
              This customer has no servers or policies. This action cannot be undone.
            </p>
          )}

          {hasServers && (
            <div className="space-y-2">
              <p className="text-sm text-foreground">
                <span className="font-medium">{impact.serverCount}</span> server(s) belong to this
                customer. What should happen to them?
              </p>
              <div className="flex flex-col gap-2">
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="radio"
                    name="srv"
                    checked={serversStrategy === 'reassign'}
                    onChange={() => setServersStrategy('reassign')}
                    className="mt-0.5 accent-primary"
                  />
                  Move them to another customer
                </label>
                {serversStrategy === 'reassign' && (
                  <div className="ml-6">
                    <SearchableSelect
                      value={targetCustomerId}
                      onChange={setTargetCustomerId}
                      options={otherCustomers.map((c) => ({ value: c.id, label: c.name }))}
                      placeholder="Select target customer…"
                      clearable={false}
                      emptyMessage="No other customers"
                    />
                  </div>
                )}
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="radio"
                    name="srv"
                    checked={serversStrategy === 'delete'}
                    onChange={() => setServersStrategy('delete')}
                    className="mt-0.5 accent-primary"
                  />
                  <span>
                    Delete the servers too{' '}
                    <span className="text-muted-foreground">
                      (also removes their sessions &amp; pending access requests)
                    </span>
                  </span>
                </label>
              </div>
            </div>
          )}

          {hasPolicies && (
            <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
              <AlertTriangle className="mr-1 inline h-3.5 w-3.5" />
              {impact.policyCount} policy(ies) scoped to this customer will become org-wide.
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={busy}>
              {busy ? 'Deleting…' : 'Delete customer'}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
