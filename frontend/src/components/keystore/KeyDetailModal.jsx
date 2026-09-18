import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Pencil,
  Trash2,
  Copy,
  Download,
  Send,
  RefreshCw,
  FileKey,
  KeyRound,
  Server as ServerIcon,
  ShieldCheck,
} from 'lucide-react';
import Modal from '@/components/shared/Modal';
import ConfirmDialog from '@/components/shared/ConfirmDialog';
import UserCell from '@/components/shared/UserCell';
import EnvironmentBadge from '@/components/shared/EnvironmentBadge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import AuthTypeBadge from './AuthTypeBadge';
import CopyButton from './CopyButton';
import EditKeyModal from './EditKeyModal';
import ExportKeyModal from './ExportKeyModal';
import DeployWizardModal from './DeployWizardModal';
import { keySourceTone, statusTone } from '@/lib/badgeTones';
import { KEY_TYPE_LABELS, labelize } from '@/lib/labels';
import { getKey, deleteKey } from '@/services/keystoreService';
import { formatDateTime, relativeTime } from '@/utils/time';

const FORMAT_LABEL = {
  openssh: 'OpenSSH',
  pkcs1: 'PKCS#1',
  pkcs8: 'PKCS#8',
  sec1: 'SEC1',
  putty_v2: 'PuTTY v2',
  putty_v3: 'PuTTY v3',
};

const DEPLOYMENT_ACTION_LABEL = { deploy: 'Export', remove: 'Remove', rotate: 'Rotate' };

const TABS = [
  { key: 'identities', label: 'Identities' },
  { key: 'servers', label: 'Servers' },
  { key: 'deployments', label: 'Recent deployments' },
  { key: 'publicKey', label: 'Public key' },
  { key: 'fingerprint', label: 'Fingerprint' },
];

function StatPill({ label }) {
  return (
    <span className="rounded-md border border-border bg-muted/40 px-2.5 py-1 text-xs text-muted-foreground">
      {label}
    </span>
  );
}

/**
 * KeyDetailModal — full detail view for a stored SSH key (Keystore → SSH
 * Keys). Opened by clicking a row (Enter also works — see DataTable's
 * onRowClick keyboard handling); the row's "…" menu keeps its own shortcuts.
 *
 * canManage gates admin-only actions (edit/export/rotate/delete); everyone
 * else gets read-only + copy/download of the public key.
 */
function KeyDetailModal({ open, onClose, keyId, canManage, onChanged }) {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [tab, setTab] = useState('identities');

  const [editOpen, setEditOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportConfirmOpen, setExportConfirmOpen] = useState(false);
  const [deployTarget, setDeployTarget] = useState(null); // { action: 'deploy' | 'rotate' }
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const [deleting, setDeleting] = useState(false);

  const fetchDetail = useCallback(async () => {
    if (!keyId) return;
    setLoading(true);
    setError('');
    try {
      const result = await getKey(keyId);
      setData(result);
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message || 'Failed to load key');
    } finally {
      setLoading(false);
    }
  }, [keyId]);

  useEffect(() => {
    if (!open || !keyId) return;
    setTab('identities');
    fetchDetail();
  }, [open, keyId, fetchDetail]);

  const key = data?.key;
  const credentials = data?.credentials || [];
  const servers = data?.servers || [];
  const deployments = data?.deployments || [];
  const stats = data?.stats || { identityCount: 0, serverCount: 0, deploymentCount: 0 };

  const downloadPublicKey = () => {
    if (!key) return;
    const blob = new Blob([key.publicKey || ''], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${key.name || 'id_key'}.pub`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const copyPublicKey = async () => {
    try {
      await navigator.clipboard.writeText(key?.publicKey || '');
    } catch {
      /* ignore */
    }
  };

  const handleDelete = async () => {
    if (!key) return;
    setDeleting(true);
    setDeleteError('');
    try {
      await deleteKey(key.id);
      setDeleteConfirmOpen(false);
      onChanged?.();
      onClose();
    } catch (err) {
      const code = err.response?.data?.error?.code;
      setDeleteError(
        code === 'KEY_IN_USE'
          ? err.response?.data?.error?.message ||
              'This key is linked to one or more identities — unlink them before deleting.'
          : err.response?.data?.error?.message || err.message || 'Failed to delete key'
      );
    } finally {
      setDeleting(false);
    }
  };

  const goToIdentity = (id) => {
    onClose();
    navigate(`/keystore?tab=identities&highlight=${id}`);
  };

  if (!open) return null;

  return (
    <>
      <Modal open={open} onClose={onClose} title={key?.name || 'SSH key'} size="xl">
        {loading ? (
          <div className="space-y-2">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-8 animate-pulse rounded bg-muted" />
            ))}
          </div>
        ) : error ? (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        ) : !key ? null : (
          <div className="space-y-4">
            {/* Header */}
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-medium text-muted-foreground">
                  {labelize(KEY_TYPE_LABELS, key.keyType)}
                  {key.bits ? ` ${key.bits}` : ''}
                </span>
                <Badge tone={keySourceTone(key.source).tone}>{keySourceTone(key.source).label}</Badge>
                {key.originalFormat && (
                  <Badge tone="neutral">{FORMAT_LABEL[key.originalFormat] || key.originalFormat}</Badge>
                )}
                {key.certificate && (
                  <Badge tone={key.certificate.expired ? 'danger' : 'success'} variant="outline" icon={ShieldCheck}>
                    Cert
                  </Badge>
                )}
              </div>
              {key.description && <p className="text-sm text-muted-foreground">{key.description}</p>}
              <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
                <span className="flex items-center gap-1.5">
                  Created by <UserCell user={key.createdBy} size="sm" />
                  on {formatDateTime(key.createdAt)}
                </span>
                <span>
                  Last exported: {key.lastExportedAt ? relativeTime(key.lastExportedAt) : 'Never'}
                </span>
              </div>
            </div>

            {/* Stats row */}
            <div className="flex flex-wrap gap-2">
              <StatPill label={`Used by ${stats.identityCount} ${stats.identityCount === 1 ? 'identity' : 'identities'}`} />
              <StatPill label={`On ${stats.serverCount} ${stats.serverCount === 1 ? 'server' : 'servers'}`} />
              <StatPill label={`${stats.deploymentCount} ${stats.deploymentCount === 1 ? 'deployment' : 'deployments'}`} />
            </div>

            {/* Action buttons */}
            <div className="flex flex-wrap gap-2 border-y border-border py-3">
              <Button variant="outline" size="sm" onClick={copyPublicKey}>
                <Copy className="mr-1.5 h-3.5 w-3.5" /> Copy public key
              </Button>
              <Button variant="outline" size="sm" onClick={downloadPublicKey}>
                <Download className="mr-1.5 h-3.5 w-3.5" /> Download public key
              </Button>
              {canManage && (
                <>
                  <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}>
                    <Pencil className="mr-1.5 h-3.5 w-3.5" /> Edit
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setExportConfirmOpen(true)}>
                    <FileKey className="mr-1.5 h-3.5 w-3.5" /> Export private key
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setDeployTarget({ action: 'deploy' })}>
                    <Send className="mr-1.5 h-3.5 w-3.5" /> Export to servers
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setDeployTarget({ action: 'rotate' })}>
                    <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Rotate…
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-destructive hover:bg-destructive/10"
                    onClick={() => {
                      setDeleteError('');
                      setDeleteConfirmOpen(true);
                    }}
                  >
                    <Trash2 className="mr-1.5 h-3.5 w-3.5" /> Delete
                  </Button>
                </>
              )}
            </div>

            {/* Tabs */}
            <div className="flex flex-wrap items-center gap-1 border-b border-border">
              {[...TABS, ...(key.certificate ? [{ key: 'certificate', label: 'Certificate' }] : [])].map((t) => (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => setTab(t.key)}
                  className={[
                    'relative px-3 py-2 text-xs font-medium transition-colors',
                    tab === t.key
                      ? 'border-b-2 border-primary text-foreground'
                      : 'text-muted-foreground hover:text-foreground',
                  ].join(' ')}
                >
                  {t.label}
                </button>
              ))}
            </div>

            {/* Tab panels */}
            <div className="min-h-[10rem]">
              {tab === 'identities' && (
                credentials.length === 0 ? (
                  <p className="py-6 text-center text-sm text-muted-foreground">No identities use this key.</p>
                ) : (
                  <ul className="divide-y divide-border rounded-md border border-border">
                    {credentials.map((c) => (
                      <li key={c.id}>
                        <button
                          type="button"
                          onClick={() => goToIdentity(c.id)}
                          className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-accent"
                        >
                          <span className="flex min-w-0 items-center gap-2">
                            <KeyRound className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                            <span className="min-w-0">
                              <span className="block truncate font-medium text-foreground">{c.name}</span>
                              <span className="block truncate font-mono text-[11px] text-muted-foreground">{c.username}</span>
                            </span>
                          </span>
                          {c.authType && <AuthTypeBadge authType={c.authType} />}
                        </button>
                      </li>
                    ))}
                  </ul>
                )
              )}

              {tab === 'servers' && (
                servers.length === 0 ? (
                  <p className="py-6 text-center text-sm text-muted-foreground">This key isn't reachable on any server.</p>
                ) : (
                  <ul className="divide-y divide-border rounded-md border border-border">
                    {servers.map((s) => (
                      <li key={s.id}>
                        <button
                          type="button"
                          onClick={() => {
                            onClose();
                            navigate(`/servers/${s.id}`);
                          }}
                          className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-accent"
                        >
                          <span className="flex min-w-0 items-center gap-2">
                            <ServerIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                            <span className="min-w-0">
                              <span className="block truncate text-foreground">{s.displayName || s.hostname}</span>
                              <span className="block truncate text-[11px] text-muted-foreground">
                                {s.via === 'identity' ? `via identity ${s.credential?.name || ''}` : 'deployed'}
                              </span>
                            </span>
                          </span>
                          <EnvironmentBadge environment={s.environment} />
                        </button>
                      </li>
                    ))}
                  </ul>
                )
              )}

              {tab === 'deployments' && (
                deployments.length === 0 ? (
                  <p className="py-6 text-center text-sm text-muted-foreground">No deployments yet.</p>
                ) : (
                  <ul className="divide-y divide-border rounded-md border border-border">
                    {deployments.map((d) => {
                      const meta = statusTone(d.status);
                      return (
                        <li key={d.id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
                          <span className="flex min-w-0 items-center gap-2">
                            <Badge tone="neutral">{DEPLOYMENT_ACTION_LABEL[d.action] || d.action}</Badge>
                            <span className="min-w-0 truncate text-foreground">
                              {d.server?.displayName || d.server?.hostname}
                            </span>
                          </span>
                          <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                            <UserCell user={d.deployedBy} size="sm" subtitle={null} fallback="system" />
                            <span title={formatDateTime(d.createdAt)}>{relativeTime(d.createdAt)}</span>
                            <Badge tone={meta.tone}>{meta.label}</Badge>
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                )
              )}

              {tab === 'publicKey' && (
                <div>
                  <div className="mb-1 flex items-center justify-between">
                    <label className="text-xs font-medium text-muted-foreground">Public key</label>
                    <CopyButton text={key.publicKey} />
                  </div>
                  <pre className="overflow-auto rounded border border-border bg-muted/40 px-3 py-2 font-mono text-xs text-foreground whitespace-pre-wrap break-all">
                    {key.publicKey}
                  </pre>
                </div>
              )}

              {tab === 'fingerprint' && (
                <div>
                  <div className="mb-1 flex items-center justify-between">
                    <label className="text-xs font-medium text-muted-foreground">Fingerprint</label>
                    <CopyButton text={key.fingerprint} />
                  </div>
                  <p className="rounded border border-border bg-muted/40 px-3 py-2 font-mono text-xs text-foreground break-all">
                    {key.fingerprint}
                  </p>
                </div>
              )}

              {tab === 'certificate' && key.certificate && (
                <div className="space-y-2">
                  <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                    <p>
                      <span className="font-medium text-foreground">{key.certificate.keyId || 'Unnamed certificate'}</span>
                      {key.certificate.expired && <span className="ml-2 text-destructive">Expired</span>}
                    </p>
                    {key.certificate.principals?.length > 0 && (
                      <p className="mt-0.5">Principals: {key.certificate.principals.join(', ')}</p>
                    )}
                    <p className="mt-0.5">
                      Valid until{' '}
                      {key.certificate.validBefore ? new Date(key.certificate.validBefore).toLocaleString() : 'unknown'}
                    </p>
                    {key.certificate.caFingerprint && <p className="mt-0.5">CA: {key.certificate.caFingerprint}</p>}
                  </div>
                  {key.certificateText && (
                    <div>
                      <div className="mb-1 flex items-center justify-between">
                        <label className="text-xs font-medium text-muted-foreground">Certificate text</label>
                        <CopyButton text={key.certificateText} />
                      </div>
                      <pre className="max-h-32 overflow-auto rounded border border-border bg-muted/40 px-3 py-2 font-mono text-[11px] text-foreground whitespace-pre-wrap break-all">
                        {key.certificateText}
                      </pre>
                    </div>
                  )}
                </div>
              )}
            </div>

            {deleteError && (
              <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {deleteError}
              </div>
            )}
          </div>
        )}
      </Modal>

      <EditKeyModal
        open={editOpen}
        sshKey={key}
        onClose={() => setEditOpen(false)}
        onSaved={() => {
          setEditOpen(false);
          fetchDetail();
          onChanged?.();
        }}
      />

      <ExportKeyModal open={exportOpen} sshKey={key} onClose={() => setExportOpen(false)} />

      <ConfirmDialog
        open={exportConfirmOpen}
        title="Export private key"
        message={`This will decrypt and display the private key material for "${key?.name}". The export is audited. Continue?`}
        confirmLabel="Continue"
        variant="destructive"
        onConfirm={() => {
          setExportConfirmOpen(false);
          setExportOpen(true);
        }}
        onCancel={() => setExportConfirmOpen(false)}
      />

      {deployTarget && key && (
        <DeployWizardModal
          open={!!deployTarget}
          onClose={() => setDeployTarget(null)}
          preselectedKeyId={deployTarget.action === 'deploy' ? key.id : undefined}
          lockKey={deployTarget.action === 'deploy'}
          defaultAction={deployTarget.action}
          onDone={() => {
            fetchDetail();
            onChanged?.();
          }}
        />
      )}

      <ConfirmDialog
        open={deleteConfirmOpen}
        title="Delete key"
        message={`Permanently delete "${key?.name}"? This cannot be undone.`}
        confirmLabel={deleting ? 'Deleting...' : 'Delete'}
        variant="destructive"
        onConfirm={handleDelete}
        onCancel={() => setDeleteConfirmOpen(false)}
      />
    </>
  );
}

export default KeyDetailModal;
