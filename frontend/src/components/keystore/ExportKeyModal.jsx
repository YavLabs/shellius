import { useEffect, useState } from 'react';
import { Download, AlertTriangle } from 'lucide-react';
import Modal from '@/components/shared/Modal';
import { Button } from '@/components/ui/button';
import CopyButton from './CopyButton';
import { exportKey } from '@/services/keystoreService';

/**
 * ExportKeyModal — admin-only private key export. Fetches the secret only
 * once (on open), never caches it beyond this component's lifetime, and
 * clears local state on close.
 */
function ExportKeyModal({ open, onClose, sshKey }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open || !sshKey) return;
    setLoading(true);
    setError('');
    setData(null);
    exportKey(sshKey.id)
      .then(setData)
      .catch((err) => setError(err.response?.data?.error?.message || 'Failed to export key'))
      .finally(() => setLoading(false));
  }, [open, sshKey]);

  const handleClose = () => {
    setData(null);
    setError('');
    onClose();
  };

  const downloadPrivate = () => {
    if (!data?.privateKey) return;
    const blob = new Blob([data.privateKey], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${sshKey?.name || 'id_key'}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <Modal open={open} onClose={handleClose} title={`Export private key — ${sshKey?.name || ''}`} size="md">
      <div className="space-y-4">
        <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          This exposes the private key material. The export is audited. Close this dialog when done — the
          key is not retained by the browser after that.
        </div>

        {loading && <div className="h-24 animate-pulse rounded bg-muted" />}

        {error && (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        {data && (
          <>
            <div>
              <div className="mb-1 flex items-center justify-between">
                <label className="text-xs font-medium text-muted-foreground">Private key</label>
                <div className="flex items-center gap-1">
                  <CopyButton text={data.privateKey} />
                  <button
                    type="button"
                    onClick={downloadPrivate}
                    className="inline-flex h-6 w-6 items-center justify-center rounded border border-input bg-background text-muted-foreground hover:bg-accent hover:text-foreground"
                    title="Download"
                  >
                    <Download className="h-3 w-3" />
                  </button>
                </div>
              </div>
              <pre className="max-h-48 overflow-auto rounded border border-border bg-muted/40 px-3 py-2 font-mono text-xs text-foreground whitespace-pre-wrap break-all">
                {data.privateKey}
              </pre>
              {data.passphraseProtected && (
                <p className="mt-1 text-xs text-muted-foreground">This key is passphrase-protected.</p>
              )}
            </div>
            <div>
              <div className="mb-1 flex items-center justify-between">
                <label className="text-xs font-medium text-muted-foreground">Public key</label>
                <CopyButton text={data.publicKey} />
              </div>
              <pre className="overflow-auto rounded border border-border bg-muted/40 px-3 py-2 font-mono text-xs text-muted-foreground whitespace-pre-wrap break-all">
                {data.publicKey}
              </pre>
            </div>
          </>
        )}

        <div className="flex justify-end pt-1">
          <Button variant="outline" onClick={handleClose}>
            Close
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export default ExportKeyModal;
