import { useState, useEffect, useCallback } from 'react';
import { Copy, Check, RefreshCw, AlertTriangle } from 'lucide-react';
import ConfirmDialog from '@/components/shared/ConfirmDialog';
import { getPublicKey, getStatus, rotate } from '@/services/caService';
import { useAuth } from '@/context/AuthContext';
import { formatDateTime } from '@/utils/time';

const ROLE_RANK = { super_admin: 4, admin: 3, operator: 2, viewer: 1 };
function isAtLeast(user, role) {
  return (ROLE_RANK[user?.role] || 0) >= (ROLE_RANK[role] || 0);
}

function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text || '');
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* ignore */
    }
  };

  return (
    <button
      onClick={handleCopy}
      className="ml-2 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded border border-input bg-background text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
      title="Copy to clipboard"
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
    </button>
  );
}

function SectionCard({ title, description, children }) {
  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="border-b border-border px-5 py-4">
        <h2 className="text-base font-semibold text-foreground">{title}</h2>
        {description && (
          <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      <div className="px-5 py-4">{children}</div>
    </div>
  );
}

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

function CaSection() {
  const { user } = useAuth();
  const isSuperAdmin = isAtLeast(user, 'super_admin');

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

  if (loading) {
    return (
      <div className="space-y-3 py-2">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="h-9 animate-pulse rounded bg-muted" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
        {error}
      </div>
    );
  }

  return (
    <dl className="space-y-0">
      <MetaRow label="Fingerprint">
        <span className="flex items-center">
          <span className="font-mono text-xs">{status?.fingerprint || '-'}</span>
          {status?.fingerprint && <CopyButton text={status.fingerprint} />}
        </span>
      </MetaRow>

      <MetaRow label="Public Key">
        <div className="flex items-start gap-2">
          <pre className="flex-1 overflow-x-auto rounded border border-border bg-muted/40 px-3 py-2 font-mono text-xs text-muted-foreground whitespace-pre-wrap break-all">
            {publicKey?.publicKey || '-'}
          </pre>
          {publicKey?.publicKey && <CopyButton text={publicKey.publicKey} />}
        </div>
      </MetaRow>

      <MetaRow label="Created">
        {formatDateTime(status?.createdAt)}
      </MetaRow>

      <MetaRow label="Last Rotated">
        {status?.rotatedAt ? formatDateTime(status.rotatedAt) : 'Never'}
      </MetaRow>

      <MetaRow label="Certificates Issued">
        {status?.certCount ?? '-'}
      </MetaRow>

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

      {isSuperAdmin && (
        <div className="mt-5 pt-4 border-t border-border">
          <div className="flex items-start gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
            <div className="flex-1 text-sm text-amber-700 dark:text-amber-300">
              Rotating the CA invalidates all existing certificates. New certificates must be
              issued and every managed host must fetch the updated CA public key before SSH
              connections will succeed.
            </div>
          </div>
          <div className="mt-4">
            <button
              onClick={() => setRotateConfirm(true)}
              disabled={rotating}
              className="flex h-9 items-center gap-2 rounded-md bg-destructive px-4 text-sm font-medium text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50"
            >
              <RefreshCw className="h-4 w-4" />
              {rotating ? 'Rotating...' : 'Rotate CA'}
            </button>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={rotateConfirm}
        title="Rotate Certificate Authority"
        message="Rotating the CA will invalidate all existing certificates. New certificates must be issued and hosts must fetch the new CA public key. This cannot be undone."
        confirmLabel="Rotate CA"
        variant="destructive"
        onConfirm={handleRotate}
        onCancel={() => setRotateConfirm(false)}
      />
    </dl>
  );
}

function Settings() {
  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Organization and infrastructure configuration.
        </p>
      </div>

      <SectionCard
        title="Certificate Authority"
        description="SSH CA key pair used to sign short-lived certificates for this organization."
      >
        <CaSection />
      </SectionCard>
    </div>
  );
}

export default Settings;
