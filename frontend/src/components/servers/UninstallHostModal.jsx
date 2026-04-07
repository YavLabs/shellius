import { useState, useEffect } from 'react';
import { Check, Copy, Loader, AlertTriangle, Eraser, ShieldCheck } from 'lucide-react';
import Modal from '@/components/shared/Modal';
import { createUninstallToken } from '@/services/bootstrapService';

const OS_TABS = [
  { key: 'linux', label: 'Linux' },
  { key: 'macos', label: 'macOS' },
];

function detectOsTab(osType) {
  if (!osType) return 'linux';
  const t = String(osType).toLowerCase();
  if (t.includes('mac') || t.includes('darwin') || t.includes('osx')) return 'macos';
  return 'linux';
}

function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);
  const onClick = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  };
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1.5 rounded-md border border-input bg-background px-2.5 py-1 text-xs font-medium text-foreground hover:bg-accent transition-colors"
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

/**
 * UninstallHostModal — mirror of BootstrapModal but emits the
 * `/api/bootstrap/uninstall.sh` one-liner. Same OS-tab UX so the
 * operator just copies + pastes on the target.
 */
function UninstallHostModal({ open, server, onClose }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [data, setData] = useState(null);
  const [tab, setTab] = useState('linux');

  useEffect(() => {
    if (!open || !server?.id) return;
    setLoading(true);
    setError('');
    setData(null);
    setTab(detectOsTab(server.osType));
    createUninstallToken(server.id)
      .then((d) => setData(d))
      .catch((err) =>
        setError(
          err?.response?.data?.error?.message ||
            err.message ||
            'Failed to generate uninstall command.'
        )
      )
      .finally(() => setLoading(false));
  }, [open, server?.id, server?.osType]);

  const command = data?.commands?.[tab] || '';
  const ttlMin = data ? Math.round(data.expiresInSeconds / 60) : 0;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={
        <span className="flex items-center gap-2">
          <Eraser className="h-4 w-4" />
          Uninstall Shellius Agent
        </span>
      }
      size="lg"
    >
      <div className="space-y-4">
        {/* What this does */}
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <p className="font-medium">
                Removes the Shellius agent from <strong>{server?.hostname}</strong>
              </p>
              <p className="mt-0.5">
                Run the command below as root on the target host. The script removes
                only Shellius-installed files and updates sshd_config — every other
                SSH file on the host is left untouched.
              </p>
            </div>
          </div>
        </div>

        {/* Safety guarantees */}
        <div className="rounded-md border border-emerald-500/40 bg-emerald-500/5 p-3">
          <div className="flex items-start gap-2">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
            <div className="text-xs text-foreground/80">
              <p className="font-medium text-emerald-700 dark:text-emerald-400">Safety guarantees</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-4">
                <li>Backs up <code>/etc/ssh/sshd_config</code> before any edit</li>
                <li>Runs <code>sshd -t</code> before reload — refuses if validation fails</li>
                <li>Never touches <code>authorized_keys</code>, host keys, or known_hosts</li>
                <li>Strips only the lines between the Shellius marker block</li>
                <li>Restores the backup automatically if anything goes wrong</li>
              </ul>
            </div>
          </div>
        </div>

        {/* OS tabs */}
        <div>
          <div className="mb-2 flex items-center justify-between">
            <div className="flex gap-1 rounded-md border border-border p-0.5">
              {OS_TABS.map((t) => (
                <button
                  key={t.key}
                  onClick={() => setTab(t.key)}
                  className={`rounded px-3 py-1 text-xs font-medium transition-colors ${
                    tab === t.key
                      ? 'bg-accent text-accent-foreground'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
            {data && (
              <span className="text-xs text-muted-foreground">
                One-time link · expires in {ttlMin} min
              </span>
            )}
          </div>

          {loading && (
            <div className="flex items-center gap-2 rounded-md border border-border bg-muted/30 p-4 text-sm text-muted-foreground">
              <Loader className="h-4 w-4 animate-spin" />
              Generating uninstall command…
            </div>
          )}

          {error && (
            <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
              {error}
            </div>
          )}

          {data && !loading && (
            <div className="relative rounded-md border border-border bg-[#0a0a0a] p-3 pr-20">
              <pre className="overflow-x-auto whitespace-pre-wrap break-all font-mono text-xs text-emerald-300">
                {command}
              </pre>
              <div className="absolute right-2 top-2">
                <CopyButton text={command} />
              </div>
            </div>
          )}
        </div>

        <div className="flex justify-end pt-2">
          <button
            onClick={onClose}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            Done
          </button>
        </div>
      </div>
    </Modal>
  );
}

export default UninstallHostModal;
