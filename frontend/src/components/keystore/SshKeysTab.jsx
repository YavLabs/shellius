import { useCallback, useEffect, useImperativeHandle, useState, forwardRef } from 'react';
import { Pencil, Trash2, Copy, Download, Send, RefreshCw, Key, FileKey, Lock } from 'lucide-react';
import DataTable from '@/components/shared/DataTable';
import ConfirmDialog from '@/components/shared/ConfirmDialog';
import EmptyState from '@/components/ui/EmptyState';
import { Badge } from '@/components/ui/badge';
import { keySourceTone } from '@/lib/badgeTones';
import { KEY_TYPE_LABELS, labelize } from '@/lib/labels';
import KeyCertBadge from './KeyCertBadge';
import GenerateKeyModal from './GenerateKeyModal';
import ImportKeyModal from './ImportKeyModal';
import EditKeyModal from './EditKeyModal';
import ExportKeyModal from './ExportKeyModal';
import DeployWizardModal from './DeployWizardModal';
import KeyDetailModal from './KeyDetailModal';
import { listKeys, deleteKey } from '@/services/keystoreService';
import { formatDateTime } from '@/utils/time';

const FORMAT_LABEL = {
  openssh: 'OpenSSH',
  pkcs1: 'PKCS#1',
  pkcs8: 'PKCS#8',
  sec1: 'SEC1',
  putty_v2: 'PuTTY v2',
  putty_v3: 'PuTTY v3',
};

const SshKeysTab = forwardRef(function SshKeysTab({ canManage, scope = 'org', canMoveToOrg = false }, ref) {
  const [keys, setKeys] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [generateOpen, setGenerateOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [detailId, setDetailId] = useState(null);
  const [editing, setEditing] = useState(null);
  const [exporting, setExporting] = useState(null);
  const [exportConfirm, setExportConfirm] = useState(null);

  const [deployTarget, setDeployTarget] = useState(null); // { key, action }

  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleteError, setDeleteError] = useState('');
  const [deleting, setDeleting] = useState(false);

  const fetch = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await listKeys({ scope });
      setKeys(data);
      return data;
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message || 'Failed to load keys');
      return [];
    } finally {
      setLoading(false);
    }
  }, [scope]);

  useEffect(() => {
    fetch();
  }, [fetch]);

  useImperativeHandle(ref, () => ({
    openImport: () => setImportOpen(true),
    openGenerate: () => setGenerateOpen(true),
    highlight: async (id) => {
      const list = keys.length ? keys : await fetch();
      const match = list.find((k) => k.id === id);
      if (match) setDetailId(match.id);
    },
  }));

  const copyPublicKey = async (key) => {
    try {
      await navigator.clipboard.writeText(key.publicKey || '');
    } catch {
      /* ignore */
    }
  };

  const downloadPublicKey = (key) => {
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

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    setDeleteError('');
    try {
      await deleteKey(deleteTarget.id);
      setDeleteTarget(null);
      fetch();
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

  const columns = [
    {
      key: 'name',
      label: 'Name',
      sortable: true,
      searchAccessor: (r) => `${r.name} ${r.fingerprint}`,
      render: (r) => (
        <div>
          <span className="flex items-center gap-1.5 font-medium text-foreground">
            {r.name}
            <KeyCertBadge certificate={r.certificate} />
            {scope === 'personal' && <Lock className="h-3 w-3 shrink-0 text-muted-foreground" aria-label="Private" />}
          </span>
          {r.description && (
            <span className="block truncate text-[11px] text-muted-foreground max-w-xs">{r.description}</span>
          )}
        </div>
      ),
    },
    {
      key: 'keyType',
      label: 'Type',
      render: (r) => (
        <span className="text-xs text-muted-foreground">
          {labelize(KEY_TYPE_LABELS, r.keyType)}
          {r.bits ? ` ${r.bits}` : ''}
        </span>
      ),
    },
    {
      key: 'fingerprint',
      label: 'Fingerprint',
      render: (r) => <span className="font-mono text-xs text-muted-foreground">{r.fingerprint}</span>,
    },
    {
      key: 'source',
      label: 'Source',
      hideBelow: 'md',
      render: (r) => (
        <div className="flex flex-col gap-1">
          <Badge tone={keySourceTone(r.source).tone}>{keySourceTone(r.source).label}</Badge>
          {r.originalFormat && (
            <span className="text-[10px] text-muted-foreground">
              {FORMAT_LABEL[r.originalFormat] || r.originalFormat}
            </span>
          )}
        </div>
      ),
    },
    {
      key: 'credentialCount',
      label: 'Used by',
      sortable: true,
      render: (r) => <span className="tabular-nums">{r.credentialCount ?? 0} identities</span>,
    },
    {
      key: 'createdAt',
      label: 'Created',
      sortable: true,
      hideBelow: 'lg',
      render: (r) => (
        <span className="text-xs text-muted-foreground" title={formatDateTime(r.createdAt)}>
          {formatDateTime(r.createdAt)}
        </span>
      ),
    },
    {
      key: 'actions',
      label: '',
      className: 'w-10',
      actions: [
        { label: 'View details', icon: Key, onClick: (r) => setDetailId(r.id) },
        { label: 'Copy public key', icon: Copy, onClick: copyPublicKey },
        { label: 'Download public key (.pub)', icon: Download, onClick: downloadPublicKey },
        ...(canManage
          ? [
              ...(scope === 'org'
                ? [
                    { label: 'Export to servers…', icon: Send, onClick: (r) => setDeployTarget({ key: r, action: 'deploy' }) },
                    { label: 'Rotate…', icon: RefreshCw, onClick: (r) => setDeployTarget({ key: r, action: 'rotate' }) },
                  ]
                : []),
              { label: 'Export private key', icon: FileKey, onClick: (r) => setExportConfirm(r) },
              { label: 'Edit', icon: Pencil, onClick: (r) => setEditing(r) },
              { separator: true },
              {
                label: 'Delete',
                icon: Trash2,
                variant: 'destructive',
                onClick: (r) => {
                  setDeleteTarget(r);
                  setDeleteError('');
                },
              },
            ]
          : []),
      ],
    },
  ];

  return (
    <div className="space-y-4">
      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {!loading && keys.length === 0 ? (
        <EmptyState
          icon={scope === 'personal' ? Lock : Key}
          title={scope === 'personal' ? 'No personal keys yet' : 'No SSH keys yet'}
          description={
            scope === 'personal'
              ? 'Generate or import a key that stays private to you — never used for org key deployment or bound to org servers.'
              : "Generate a new key pair or import an existing one to start deploying to hosts that can't use CA certificates."
          }
          action={canManage ? { label: 'Generate key', onClick: () => setGenerateOpen(true) } : undefined}
        />
      ) : (
        <DataTable
          columns={columns}
          data={keys}
          loading={loading}
          onRowClick={(r) => setDetailId(r.id)}
          searchPlaceholder="Search keys..."
          emptyMessage="No keys match your search"
        />
      )}

      <GenerateKeyModal open={generateOpen} onClose={() => setGenerateOpen(false)} scope={scope} onSaved={fetch} />
      <ImportKeyModal open={importOpen} onClose={() => setImportOpen(false)} scope={scope} onSaved={fetch} />
      <EditKeyModal open={!!editing} sshKey={editing} onClose={() => setEditing(null)} onSaved={fetch} />
      <ExportKeyModal open={!!exporting} sshKey={exporting} onClose={() => setExporting(null)} />

      <KeyDetailModal
        open={!!detailId}
        keyId={detailId}
        canManage={canManage}
        scope={scope}
        canMoveToOrg={canMoveToOrg}
        onClose={() => setDetailId(null)}
        onChanged={fetch}
      />

      {deployTarget && (
        <DeployWizardModal
          open={!!deployTarget}
          onClose={() => setDeployTarget(null)}
          preselectedKeyId={deployTarget.action === 'deploy' ? deployTarget.key.id : undefined}
          lockKey={deployTarget.action === 'deploy'}
          defaultAction={deployTarget.action}
          onDone={fetch}
        />
      )}

      <ConfirmDialog
        open={!!exportConfirm}
        title="Export private key"
        message={`This will decrypt and display the private key material for "${exportConfirm?.name}". The export is audited. Continue?`}
        confirmLabel="Continue"
        variant="destructive"
        onConfirm={() => {
          setExporting(exportConfirm);
          setExportConfirm(null);
        }}
        onCancel={() => setExportConfirm(null)}
      />

      <ConfirmDialog
        open={!!deleteTarget}
        title="Delete key"
        message={`Permanently delete "${deleteTarget?.name}"? This cannot be undone.`}
        confirmLabel={deleting ? 'Deleting...' : 'Delete'}
        variant="destructive"
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />

      {deleteError && (
        <div className="fixed bottom-4 right-4 z-50 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive shadow-lg">
          {deleteError}
        </div>
      )}
    </div>
  );
});

export default SshKeysTab;
