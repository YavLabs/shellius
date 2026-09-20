import { useState, useEffect } from 'react';
import { Check, Copy, Loader, AlertTriangle, ExternalLink } from 'lucide-react';
import Modal from '@/components/shared/Modal';
import { createBootstrapToken } from '@/services/bootstrapService';

const OS_TABS = [
  { key: 'linux', label: 'Linux' },
  { key: 'macos', label: 'macOS' },
  { key: 'windows', label: 'Windows' },
];

function detectOsTab(osType) {
  if (!osType) return 'linux';
  const t = String(osType).toLowerCase();
  if (t.includes('win')) return 'windows';
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

function BootstrapModal({ open, server, mode = 'full', onClose }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [data, setData] = useState(null);
  const [tab, setTab] = useState('linux');
  const isPosture = mode === 'posture';

  useEffect(() => {
    if (!open || !server?.id) return;
    setLoading(true);
    setError('');
    setData(null);
    setTab(detectOsTab(server.osType));
    createBootstrapToken(server.id, mode)
      .then((d) => setData(d))
      .catch((err) =>
        setError(
          err?.response?.data?.error?.message ||
            err.message ||
            'Failed to generate bootstrap command.'
        )
      )
      .finally(() => setLoading(false));
  }, [open, server?.id, server?.osType, mode]);

  const command = data?.commands?.[tab] || '';
  const ttlMin = data ? Math.round(data.expiresInSeconds / 60) : 0;

  return (
    <Modal open={open} onClose={onClose} title={isPosture ? 'Install posture collector' : 'Bootstrap target host'} size="lg">
      <div className="space-y-4 p-5 max-md:p-0">
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            {isPosture ? (
              <div>
                <p className="font-medium">Posture-only install — SSH access is untouched:</p>
                <p className="mt-0.5">
                  This host connects with a stored identity, not a Shellius certificate.
                  Run the command below <strong>once</strong> on{' '}
                  <strong>{server?.hostname || 'the target server'}</strong> as an
                  administrator. It installs only the posture collector, its timer and
                  its own sudoers drop-in — it never touches sshd config, CA trust,
                  check-principals or JIT, and changes nothing about how SSH
                  authentication works on this host.
                </p>
              </div>
            ) : (
              <div>
                <p className="font-medium">Before anyone can connect via Shellius:</p>
                <p className="mt-0.5">
                  The target host must trust the Shellius CA and run the
                  <code className="mx-1 rounded bg-amber-500/20 px-1">check-principals</code>
                  agent. Run the command below <strong>once</strong> on{' '}
                  <strong>{server?.hostname || 'the target server'}</strong> as an
                  administrator. It installs the CA public key, the agent secret, the
                  check-principals script, and updates sshd.
                </p>
              </div>
            )}
          </div>
        </div>

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
              Generating install command…
            </div>
          )}

          {error && (
            <div className="rounded-md border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-600 dark:text-red-400">
              {error}
            </div>
          )}

          {data && !loading && (
            <>
              <div className="relative rounded-md border border-border bg-ink p-3 pr-20">
                <pre className="overflow-x-auto whitespace-pre-wrap break-all font-mono text-xs text-emerald-300">
                  {command}
                </pre>
                <div className="absolute right-2 top-2">
                  <CopyButton text={command} />
                </div>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                {tab === 'windows' ? (
                  <>Run in an <strong>elevated PowerShell</strong> (Run as Administrator).</>
                ) : (
                  <>Run as <strong>root</strong> (the command uses <code>sudo</code>).</>
                )}
              </p>
            </>
          )}
        </div>

        <div className="rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
          <p className="font-medium text-foreground">What the script does</p>
          {isPosture ? (
            <ul className="mt-1 list-disc space-y-0.5 pl-4">
              <li>
                Installs the posture collector, its systemd unit and timer, and its own
                sudoers drop-in (least-privilege, scoped to the collector's commands only).
              </li>
              <li>
                Stores the agent token at <code>/etc/shellius/agent-token</code>{' '}
                (root-only) so the collector can report snapshots to the Shellius API.
              </li>
              <li>
                Does not write the CA public key, does not touch{' '}
                <code>sshd_config</code>, and does not install{' '}
                <code>shellius-check-principals</code> — how this host authenticates
                SSH connections is unchanged.
              </li>
              <li>Idempotent — safe to re-run. No static authorized_keys are added.</li>
              <li>Linux / systemd hosts only (v1) — the Windows command is a no-op.</li>
            </ul>
          ) : (
            <ul className="mt-1 list-disc space-y-0.5 pl-4">
              <li>
                Writes the Shellius CA public key to{' '}
                <code>/etc/ssh/shellius_ca.pub</code> (or{' '}
                <code>%ProgramData%\ssh\shellius_ca.pub</code> on Windows).
              </li>
              <li>
                Stores the agent shared secret at{' '}
                <code>/etc/shellius/agent-token</code> (root-only) so
                check-principals can call the Shellius API.
              </li>
              <li>
                Installs <code>shellius-check-principals</code> and wires it into{' '}
                <code>sshd_config</code> via{' '}
                <code>AuthorizedPrincipalsCommand</code>, then reloads sshd.
              </li>
              <li>Idempotent — safe to re-run. No static authorized_keys are added.</li>
            </ul>
          )}
        </div>

        <div data-sheet-footer className="flex items-center justify-between border-t border-border pt-3">
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              if (data?.urls?.sh) window.open(data.urls.sh, '_blank');
            }}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <ExternalLink className="h-3 w-3" />
            View raw script
          </a>
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

export default BootstrapModal;
