import { useEffect, useState } from 'react';
import { AlertTriangle, Loader2, Cloud } from 'lucide-react';
import Modal from '@/components/shared/Modal';
import { Button } from '@/components/ui/button';
import { getServerDeleteImpact, deleteServer } from '@/services/serverService';

/**
 * DeleteServerDialog — hard-delete with an impact summary. Surfaces live
 * sessions (force-terminated), pending requests, and the session history that
 * will be permanently removed.
 */
export default function DeleteServerDialog({ server, open, onClose, onDeleted }) {
  const [impact, setImpact] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open || !server?.id) return undefined;
    let cancelled = false;
    setLoading(true);
    setError('');
    setImpact(null);
    getServerDeleteImpact(server.id)
      .then((imp) => !cancelled && setImpact(imp))
      .catch((e) => !cancelled && setError(e.response?.data?.error?.message || 'Failed to load impact'))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [open, server?.id]);

  const handleDelete = async () => {
    setBusy(true);
    setError('');
    try {
      await deleteServer(server.id);
      onDeleted?.();
    } catch (e) {
      setError(e.response?.data?.error?.message || 'Delete failed');
    } finally {
      setBusy(false);
    }
  };

  const name = server?.displayName || server?.hostname || 'server';

  return (
    <Modal open={open} onClose={onClose} title={`Delete ${name}`}>
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

          {impact?.isCloud && (
            <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
              <Cloud className="mr-1 inline h-3.5 w-3.5" />
              This is a cloud-discovered server ({impact.cloudProvider}). Deleting it here removes the
              Shellius record; it will reappear on the next cloud sync if the instance still exists.
            </div>
          )}

          <p className="text-sm text-foreground">Deleting this server will:</p>
          <ul className="space-y-1.5 text-sm text-muted-foreground">
            {impact?.activeSessions > 0 && (
              <li className="flex items-center gap-2 text-amber-700 dark:text-amber-400">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                Force-close <span className="font-medium">{impact.activeSessions}</span> live session(s)
              </li>
            )}
            <li>
              Permanently remove <span className="font-medium text-foreground">{impact?.totalSessions ?? 0}</span>{' '}
              session record(s) and <span className="font-medium text-foreground">{impact?.pendingRequests ?? 0}</span>{' '}
              pending/approved access request(s)
            </li>
            {impact?.certificates > 0 && (
              <li>Unlink {impact.certificates} issued certificate(s) (kept for audit)</li>
            )}
          </ul>
          <p className="text-xs text-muted-foreground">This action cannot be undone.</p>

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={busy}>
              {busy ? 'Deleting…' : 'Delete server'}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
