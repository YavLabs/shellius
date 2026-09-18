import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Server as ServerIcon, PlugZap, Pencil, Trash2, MoreHorizontal, KeyRound, UserRound } from 'lucide-react';
import Modal from '@/components/shared/Modal';
import ConfirmDialog from '@/components/shared/ConfirmDialog';
import EmptyState from '@/components/ui/EmptyState';
import StatTile from '@/components/shared/StatTile';
import EnvironmentBadge from '@/components/shared/EnvironmentBadge';
import UserCell from '@/components/shared/UserCell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import AuthTypeBadge from './AuthTypeBadge';
import KeyDetailModal from './KeyDetailModal';
import IdentityFormModal from './IdentityFormModal';
import TestConnectionModal from './TestConnectionModal';
import { getCredential, deleteCredential } from '@/services/keystoreService';
import { formatDateTime, relativeTime } from '@/utils/time';

/** DetailItem — one cell in the "Details" definition grid: muted xs label
 * on top, text-sm value below. `full` spans both columns. */
function DetailItem({ label, value, full }) {
  return (
    <div className={full ? 'sm:col-span-2' : undefined}>
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="mt-1 text-sm text-foreground">{value ?? '—'}</div>
    </div>
  );
}

/**
 * IdentityDetailModal — full detail view for a stored Keystore identity
 * (username/password or username/key credential). Mirrors KeyDetailModal's
 * structure: header with icon tile + meta, a primary/secondary action row
 * with an overflow menu for rarer actions, a "Details" grid, a stat row,
 * then a Servers tab.
 *
 * canManage gates edit/delete; everyone can still test the connection and
 * browse servers/linked key.
 */
function IdentityDetailModal({ open, onClose, credentialId, canManage, onChanged }) {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const [testOpen, setTestOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [linkedKeyOpen, setLinkedKeyOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(false);
  const [inUseInfo, setInUseInfo] = useState(null);
  const [deleteError, setDeleteError] = useState('');
  const [deleting, setDeleting] = useState(false);

  const fetchDetail = useCallback(() => {
    if (!credentialId) return;
    setLoading(true);
    setError('');
    getCredential(credentialId)
      .then(setData)
      .catch((err) => setError(err.response?.data?.error?.message || err.message || 'Failed to load identity'))
      .finally(() => setLoading(false));
  }, [credentialId]);

  useEffect(() => {
    if (!open || !credentialId) return;
    fetchDetail();
  }, [open, credentialId, fetchDetail]);

  const credential = data?.credential;
  const servers = data?.servers || [];

  const handleDelete = async (force = false) => {
    if (!credential) return;
    setDeleting(true);
    setDeleteError('');
    try {
      await deleteCredential(credential.id, { force });
      setDeleteTarget(false);
      setInUseInfo(null);
      onChanged?.();
      onClose();
    } catch (err) {
      const code = err.response?.data?.error?.code;
      if (code === 'CREDENTIAL_IN_USE' && !force) {
        setInUseInfo({
          message: err.response?.data?.error?.message || 'This identity is used by one or more servers.',
        });
      } else {
        setDeleteError(err.response?.data?.error?.message || err.message || 'Failed to delete identity');
      }
    } finally {
      setDeleting(false);
    }
  };

  if (!open) return null;

  return (
    <>
      <Modal open={open} onClose={onClose} title={credential?.name || 'Identity'} size="lg">
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
        ) : !credential ? null : (
          <div className="space-y-6">
            {/* Header */}
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="flex min-w-0 items-start gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border bg-card">
                  <UserRound className="h-5 w-5 text-primary" />
                </div>
                <div className="min-w-0">
                  <h2 className="truncate text-base font-semibold text-foreground">{credential.name}</h2>
                  <p className="font-mono text-sm text-muted-foreground">{credential.username}</p>
                  {credential.description && (
                    <p className="mt-1 max-w-md text-sm text-muted-foreground">{credential.description}</p>
                  )}
                </div>
              </div>
              <div className="flex shrink-0 items-center justify-end gap-1.5">
                <AuthTypeBadge authType={credential.authType} />
              </div>
            </div>

            {/* Actions */}
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={() => setTestOpen(true)}>
                <PlugZap className="mr-1.5 h-3.5 w-3.5" /> Test connection
              </Button>
              {canManage && (
                <>
                  <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}>
                    <Pencil className="mr-1.5 h-3.5 w-3.5" /> Edit
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="outline" size="icon" className="h-9 w-9">
                        <MoreHorizontal className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-44">
                      <DropdownMenuItem
                        className="text-destructive focus:text-destructive"
                        onClick={() => {
                          setDeleteError('');
                          setInUseInfo(null);
                          setDeleteTarget(true);
                        }}
                      >
                        <Trash2 className="mr-2 h-4 w-4" /> Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </>
              )}
            </div>

            {/* Details grid */}
            <div className="rounded-lg border border-border p-4">
              <div className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
                <DetailItem label="Username" value={<span className="font-mono">{credential.username}</span>} />
                <DetailItem label="Auth method" value={<AuthTypeBadge authType={credential.authType} />} />
                <DetailItem
                  label="Linked key"
                  full
                  value={
                    credential.sshKey ? (
                      <button
                        type="button"
                        onClick={() => setLinkedKeyOpen(true)}
                        className="inline-flex items-center gap-2 rounded-md border border-border px-2 py-1 text-left hover:bg-accent"
                      >
                        <KeyRound className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        <span>
                          <span className="block text-sm text-foreground">{credential.sshKey.name}</span>
                          <span className="block font-mono text-[11px] text-muted-foreground">
                            {credential.sshKey.fingerprint}
                          </span>
                        </span>
                      </button>
                    ) : (
                      <span className="text-muted-foreground">None</span>
                    )
                  }
                />
                {credential.createdBy && (
                  <DetailItem label="Created by" value={<UserCell user={credential.createdBy} size="sm" />} />
                )}
                <DetailItem label="Created" value={formatDateTime(credential.createdAt)} />
                <DetailItem
                  label="Last used"
                  value={credential.lastUsedAt ? relativeTime(credential.lastUsedAt) : 'Never'}
                />
                {credential.tags?.length > 0 && (
                  <DetailItem
                    label="Tags"
                    full
                    value={
                      <div className="flex flex-wrap gap-1.5">
                        {credential.tags.map((tag) => (
                          <Badge key={tag} tone="neutral">
                            {tag}
                          </Badge>
                        ))}
                      </div>
                    }
                  />
                )}
              </div>
            </div>

            {/* Stats row */}
            <div className="flex gap-3">
              <StatTile label="Servers" value={servers.length} className="w-40" />
            </div>

            {/* Servers */}
            <div>
              <p className="mb-2 text-xs font-medium text-muted-foreground">Servers using this identity</p>
              {servers.length === 0 ? (
                <EmptyState
                  icon={ServerIcon}
                  title="No servers use this identity"
                  className="border-none bg-transparent py-10"
                />
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
                          <span className="truncate text-foreground">{s.displayName || s.hostname}</span>
                        </span>
                        {s.environment && <EnvironmentBadge environment={s.environment} />}
                      </button>
                    </li>
                  ))}
                </ul>
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

      {credential && (
        <TestConnectionModal open={testOpen} credential={credential} onClose={() => setTestOpen(false)} />
      )}

      <IdentityFormModal
        open={editOpen}
        identity={credential}
        onClose={() => setEditOpen(false)}
        onSaved={() => {
          setEditOpen(false);
          fetchDetail();
          onChanged?.();
        }}
      />

      {credential?.sshKey && (
        <KeyDetailModal
          open={linkedKeyOpen}
          keyId={credential.sshKey.id}
          canManage={canManage}
          onClose={() => setLinkedKeyOpen(false)}
          onChanged={onChanged}
        />
      )}

      <ConfirmDialog
        open={!!deleteTarget && !inUseInfo}
        title="Delete identity"
        message={`Permanently delete "${credential?.name}"? This cannot be undone.`}
        confirmLabel={deleting ? 'Deleting…' : 'Delete'}
        variant="destructive"
        onConfirm={() => handleDelete(false)}
        onCancel={() => {
          setDeleteTarget(false);
          setDeleteError('');
        }}
      />

      <ConfirmDialog
        open={!!deleteTarget && !!inUseInfo}
        title="Identity in use"
        message={`${inUseInfo?.message || ''} Force-deleting will detach it from every server — those servers revert to certificate-mode (CA) authentication.`}
        confirmLabel={deleting ? 'Detaching…' : 'Force detach & delete'}
        variant="destructive"
        onConfirm={() => handleDelete(true)}
        onCancel={() => {
          setDeleteTarget(false);
          setInUseInfo(null);
        }}
      />
    </>
  );
}

export default IdentityDetailModal;
