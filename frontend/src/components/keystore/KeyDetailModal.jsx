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
  MoreHorizontal,
  Users,
  Building2,
} from 'lucide-react';
import Modal from '@/components/shared/Modal';
import ConfirmDialog from '@/components/shared/ConfirmDialog';
import UserCell from '@/components/shared/UserCell';
import EnvironmentBadge from '@/components/shared/EnvironmentBadge';
import ScopeBadge from '@/components/shared/ScopeBadge';
import EmptyState from '@/components/ui/EmptyState';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import AuthTypeBadge from './AuthTypeBadge';
import CopyButton from './CopyButton';
import EditKeyModal from './EditKeyModal';
import ExportKeyModal from './ExportKeyModal';
import DeployWizardModal from './DeployWizardModal';
import { keySourceTone, statusTone } from '@/lib/badgeTones';
import { KEY_TYPE_LABELS, labelize } from '@/lib/labels';
import { getKey, deleteKey, moveKeyToOrg } from '@/services/keystoreService';
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
  { key: 'exports', label: 'Exports' },
  { key: 'publicKey', label: 'Public key' },
];

/** DetailItem — one cell in the "Details" definition grid: muted xs label
 * on top, text-sm value below. `full` spans both columns (used for the
 * fingerprint row, which is long and monospace). */
function DetailItem({ label, value, full }) {
  return (
    <div className={full ? 'sm:col-span-2' : undefined}>
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="mt-1 text-sm text-foreground">{value ?? '—'}</div>
    </div>
  );
}

function EmptyTab({ icon, title }) {
  return <EmptyState icon={icon} title={title} className="border-none bg-transparent py-10" />;
}

/**
 * KeyDetailModal — full detail view for a stored SSH key (Keystore → SSH
 * Keys). Opened by clicking a row (Enter also works — see DataTable's
 * onRowClick keyboard handling); the row's "…" menu keeps its own shortcuts.
 *
 * canManage gates admin-only actions (edit/export/rotate/delete); everyone
 * else gets read-only + copy/download of the public key.
 */
function KeyDetailModal({ open, onClose, keyId, canManage, scope = 'org', canMoveToOrg = false, onChanged }) {
  const navigate = useNavigate();
  const isPersonal = scope === 'personal';
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
  const [moveConfirmOpen, setMoveConfirmOpen] = useState(false);
  const [moving, setMoving] = useState(false);
  const [moveError, setMoveError] = useState('');

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
    navigate(`/keystore?scope=${scope}&tab=identities&highlight=${id}`);
  };

  const handleMoveToOrg = async () => {
    if (!key) return;
    setMoving(true);
    setMoveError('');
    try {
      await moveKeyToOrg(key.id);
      setMoveConfirmOpen(false);
      onChanged?.();
      onClose();
    } catch (err) {
      setMoveError(err.response?.data?.error?.message || err.message || 'Failed to move key to the organization');
    } finally {
      setMoving(false);
    }
  };

  if (!open) return null;

  const source = key ? keySourceTone(key.source) : null;
  // Counts live on the tabs (Identities (2), Servers (5), …) instead of a
  // separate stat row. Personal keys are never bound to org servers/exports
  // (docs/personal-vault.md rule 2), so those tabs don't apply to them.
  const counts = { identities: stats.identityCount, servers: stats.serverCount, exports: stats.deploymentCount };
  const baseTabs = isPersonal ? TABS.filter((t) => t.key !== 'servers' && t.key !== 'exports') : TABS;
  const allTabs = (key?.certificate ? [...baseTabs, { key: 'certificate', label: 'Certificate' }] : baseTabs).map((t) => ({
    ...t,
    count: counts[t.key],
  }));

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
          <div className="space-y-6">
            {/* Header */}
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="flex min-w-0 items-start gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border bg-card">
                  <KeyRound className="h-5 w-5 text-primary" />
                </div>
                <div className="min-w-0">
                  <h2 className="flex items-center gap-2 truncate text-base font-semibold text-foreground">
                    {key.name}
                    {isPersonal && <ScopeBadge scope="personal" />}
                  </h2>
                  <p className="text-sm text-muted-foreground">
                    {labelize(KEY_TYPE_LABELS, key.keyType)}
                    {key.bits ? ` · ${key.bits}-bit` : ''}
                  </p>
                  {key.description && (
                    <p className="mt-1 max-w-md text-sm text-muted-foreground">{key.description}</p>
                  )}
                </div>
              </div>
              <div className="flex w-full flex-wrap items-center gap-2 sm:ml-auto sm:w-auto sm:justify-end">
                {canManage && !isPersonal && (
                  <Button size="sm" onClick={() => setDeployTarget({ action: 'deploy' })}>
                    <Send className="mr-1.5 h-3.5 w-3.5" /> Export to servers
                  </Button>
                )}
                <Button variant="outline" size="sm" onClick={copyPublicKey} aria-label="Copy public key" title="Copy public key">
                  <Copy className="h-3.5 w-3.5 sm:mr-1.5" />
                  <span className="hidden sm:inline">Copy public key</span>
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="icon" className="h-9 w-9" aria-label="More actions">
                      <MoreHorizontal className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-52">
                    <DropdownMenuItem onClick={downloadPublicKey}>
                      <Download className="mr-2 h-4 w-4" /> Download .pub
                    </DropdownMenuItem>
                    {canManage && (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onClick={() => setEditOpen(true)}>
                          <Pencil className="mr-2 h-4 w-4" /> Edit
                        </DropdownMenuItem>
                        {!isPersonal && (
                          <DropdownMenuItem onClick={() => setDeployTarget({ action: 'rotate' })}>
                            <RefreshCw className="mr-2 h-4 w-4" /> Rotate…
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuItem
                          onClick={() => {
                            setDeleteError('');
                            setExportConfirmOpen(true);
                          }}
                        >
                          <FileKey className="mr-2 h-4 w-4" /> Export private key
                        </DropdownMenuItem>
                        {isPersonal && canMoveToOrg && (
                          <DropdownMenuItem
                            onClick={() => {
                              setMoveError('');
                              setMoveConfirmOpen(true);
                            }}
                          >
                            <Building2 className="mr-2 h-4 w-4" /> Move to organization…
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          className="text-destructive focus:text-destructive"
                          onClick={() => {
                            setDeleteError('');
                            setDeleteConfirmOpen(true);
                          }}
                        >
                          <Trash2 className="mr-2 h-4 w-4" /> Delete
                        </DropdownMenuItem>
                      </>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>

            {/* Details grid */}
            <div className="rounded-lg border border-border p-4">
              <div className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
                <DetailItem label="Type" value={labelize(KEY_TYPE_LABELS, key.keyType)} />
                <DetailItem label="Bits" value={key.bits || '—'} />
                <DetailItem
                  label="Fingerprint"
                  full
                  value={
                    <span className="flex items-center gap-2">
                      <span className="break-all font-mono text-xs text-foreground">{key.fingerprint}</span>
                      <CopyButton text={key.fingerprint} />
                    </span>
                  }
                />
                <DetailItem
                  label="Source / format"
                  value={
                    <span className="flex flex-wrap items-center gap-1.5">
                      <Badge tone={source.tone}>{source.label}</Badge>
                      {key.originalFormat && (
                        <Badge tone="neutral">{FORMAT_LABEL[key.originalFormat] || key.originalFormat}</Badge>
                      )}
                    </span>
                  }
                />
                <DetailItem
                  label="Certificate"
                  value={
                    key.certificate ? (
                      <Badge tone={key.certificate.expired ? 'danger' : 'success'} variant="outline" icon={ShieldCheck}>
                        {key.certificate.expired ? 'Expired' : 'Valid'}
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground">None</span>
                    )
                  }
                />
                <DetailItem label="Created by" value={<UserCell user={key.createdBy} size="sm" />} />
                <DetailItem label="Created" value={formatDateTime(key.createdAt)} />
                <DetailItem
                  label="Last exported"
                  value={key.lastExportedAt ? relativeTime(key.lastExportedAt) : 'Never'}
                />
              </div>
            </div>

            {/* Tabs */}
            <div>
              <div className="flex flex-wrap items-center gap-1 border-b border-border">
                {allTabs.map((t) => (
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
                    {t.count > 0 && <span className="ml-1 tabular-nums text-muted-foreground">({t.count})</span>}
                  </button>
                ))}
              </div>

              {/* Tab panels */}
              <div className="min-h-[10rem] pt-4">
                {tab === 'identities' &&
                  (credentials.length === 0 ? (
                    <EmptyTab icon={Users} title="No identities use this key" />
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
                                <span className="block truncate font-mono text-[11px] text-muted-foreground">
                                  {c.username}
                                </span>
                              </span>
                            </span>
                            {c.authType && <AuthTypeBadge authType={c.authType} />}
                          </button>
                        </li>
                      ))}
                    </ul>
                  ))}

                {tab === 'servers' &&
                  (servers.length === 0 ? (
                    <EmptyTab icon={ServerIcon} title="This key isn't reachable on any server" />
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
                                  {s.via === 'identity' ? `via identity ${s.credential?.name || ''}` : 'Deployed'}
                                </span>
                              </span>
                            </span>
                            <EnvironmentBadge environment={s.environment} />
                          </button>
                        </li>
                      ))}
                    </ul>
                  ))}

                {tab === 'exports' &&
                  (deployments.length === 0 ? (
                    <EmptyTab icon={Send} title="No exports yet" />
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
                              <UserCell user={d.deployedBy} size="sm" subtitle={null} fallback="System" />
                              <span title={formatDateTime(d.createdAt)}>{relativeTime(d.createdAt)}</span>
                              <Badge tone={meta.tone}>{meta.label}</Badge>
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  ))}

                {tab === 'publicKey' && (
                  <div>
                    <div className="mb-1 flex items-center justify-between">
                      <label className="text-xs font-medium text-muted-foreground">Public key</label>
                      <div className="flex items-center gap-1.5">
                        <CopyButton text={key.publicKey} />
                        <Button variant="outline" size="sm" onClick={downloadPublicKey}>
                          <Download className="mr-1.5 h-3.5 w-3.5" /> Download
                        </Button>
                      </div>
                    </div>
                    <pre className="overflow-auto rounded border border-border bg-muted/40 px-3 py-2 font-mono text-xs text-foreground whitespace-pre-wrap break-all">
                      {key.publicKey}
                    </pre>
                  </div>
                )}

                {tab === 'certificate' && key.certificate && (
                  <div className="space-y-3">
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
                        {key.certificate.validBefore ? new Date(key.certificate.validBefore).toLocaleString() : 'Unknown'}
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
            </div>

            {moveError && (
              <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {moveError}
              </div>
            )}

            {deleteError && (
              <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {deleteError}
              </div>
            )}
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={moveConfirmOpen}
        title="Move to organization"
        message={`Move "${key?.name}" into the org Keystore? This is one-way — it becomes visible to everyone with Keystore access and can be bound to servers or exported to hosts.`}
        confirmLabel={moving ? 'Moving…' : 'Move to organization'}
        onConfirm={handleMoveToOrg}
        onCancel={() => setMoveConfirmOpen(false)}
      />

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
        confirmLabel={deleting ? 'Deleting…' : 'Delete'}
        variant="destructive"
        onConfirm={handleDelete}
        onCancel={() => setDeleteConfirmOpen(false)}
      />
    </>
  );
}

export default KeyDetailModal;
