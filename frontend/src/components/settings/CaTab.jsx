import { useState, useEffect, useCallback } from 'react';
import { RefreshCw, AlertTriangle } from 'lucide-react';
import ConfirmDialog from '@/components/shared/ConfirmDialog';
import { Button } from '@/components/ui/button';
import { SectionCard, CopyButton } from '@/components/settings/shared';
import { getPublicKey, getStatus, rotate } from '@/services/caService';
import { useAuth } from '@/context/AuthContext';
import { formatDateTime } from '@/utils/time';
import { can } from '@/lib/permissions';

function MetaRow({ label, children }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-border py-3 last:border-0">
      <dt className="w-40 shrink-0 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="flex-1 text-sm text-foreground break-all">{children}</dd>
    </div>
  );
}

/** Administration → Organization → Certificate authority (ca.view; rotate needs ca.rotate). */
function CaTab() {
  const { user } = useAuth();
  const canRotate = can(user, 'ca.rotate');

  const [status, setStatus] = useState(null);
  const [publicKey, setPublicKey] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [rotateConfirm, setRotateConfirm] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [rotateError, setRotateError] = useState('');
  const [rotateSuccess, setRotateSuccess] = useState(false);

  const fetchCa = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [st, pk] = await Promise.all([getStatus(), getPublicKey()]);
      setStatus(st);
      setPublicKey(pk);
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message || 'Failed to load CA status');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchCa();
  }, [fetchCa]);

  const handleRotate = async () => {
    setRotating(true);
    setRotateError('');
    setRotateSuccess(false);
    try {
      await rotate();
      setRotateConfirm(false);
      setRotateSuccess(true);
      setTimeout(() => setRotateSuccess(false), 5000);
      await fetchCa();
    } catch (err) {
      setRotateError(
        err.response?.data?.error?.message || err.message || 'Rotation failed'
      );
      setRotateConfirm(false);
    } finally {
      setRotating(false);
    }
  };

  return (
    <SectionCard
      title="Certificate authority"
      description="SSH CA key pair used to sign short-lived certificates for this organization."
    >
      {loading ? (
        <div className="space-y-3 py-2">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-9 animate-pulse rounded bg-muted" />
          ))}
        </div>
      ) : error ? (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : (
        <dl className="space-y-0">
          <MetaRow label="Fingerprint">
            <span className="flex items-center">
              <span className="font-mono text-xs">{status?.fingerprint || '-'}</span>
              {status?.fingerprint && <CopyButton text={status.fingerprint} />}
            </span>
          </MetaRow>

          <MetaRow label="Public key">
            <div className="flex items-start gap-2">
              <pre className="flex-1 overflow-x-auto rounded border border-border bg-muted/40 px-3 py-2 font-mono text-xs text-muted-foreground whitespace-pre-wrap break-all">
                {publicKey?.publicKey || '-'}
              </pre>
              {publicKey?.publicKey && <CopyButton text={publicKey.publicKey} />}
            </div>
          </MetaRow>

          <MetaRow label="Created">{formatDateTime(status?.createdAt)}</MetaRow>
          <MetaRow label="Last rotated">
            {status?.rotatedAt ? formatDateTime(status.rotatedAt) : 'Never'}
          </MetaRow>
          <MetaRow label="Certificates issued">{status?.certCount ?? '-'}</MetaRow>
          <MetaRow label="Active">
            <span
              className={
                status?.isActive
                  ? 'text-emerald-600 dark:text-emerald-400'
                  : 'text-destructive'
              }
            >
              {status?.isActive ? 'Yes' : 'No'}
            </span>
          </MetaRow>

          {rotateSuccess && (
            <div className="mt-4 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300">
              CA rotated successfully. All hosts must fetch the new CA public key.
            </div>
          )}

          {rotateError && (
            <div className="mt-4 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {rotateError}
            </div>
          )}

          {canRotate && (
            <div className="mt-5 border-t border-border pt-4">
              <div className="flex items-start gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-3">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
                <div className="flex-1 text-sm text-amber-700 dark:text-amber-300">
                  Rotating the CA invalidates all existing certificates. New certificates must be
                  issued and every managed host must fetch the updated CA public key before SSH
                  connections will succeed.
                </div>
              </div>
              <div className="mt-4">
                <Button
                  variant="destructive"
                  onClick={() => setRotateConfirm(true)}
                  disabled={rotating}
                >
                  <RefreshCw className="mr-2 h-4 w-4" />
                  {rotating ? 'Rotating...' : 'Rotate CA'}
                </Button>
              </div>
            </div>
          )}
        </dl>
      )}

      <ConfirmDialog
        open={rotateConfirm}
        title="Rotate certificate authority"
        message="Rotating the CA will invalidate all existing certificates. New certificates must be issued and hosts must fetch the new CA public key. This cannot be undone."
        confirmLabel="Rotate CA"
        variant="destructive"
        onConfirm={handleRotate}
        onCancel={() => setRotateConfirm(false)}
      />
    </SectionCard>
  );
}

export default CaTab;
