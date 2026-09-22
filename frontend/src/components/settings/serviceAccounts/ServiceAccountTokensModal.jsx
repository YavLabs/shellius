import { useCallback, useEffect, useMemo, useState } from 'react';
import { KeyRound, Loader2, Plus, Trash2 } from 'lucide-react';
import Modal from '@/components/shared/Modal';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { SwitchField } from '@/components/ui/switch';
import ConfirmDialog from '@/components/shared/ConfirmDialog';
import TokenRevealDialog from '@/components/settings/tokens/TokenRevealDialog';
import TokenScopePicker from '@/components/settings/tokens/TokenScopePicker';
import { formatTokenExpiry, summarizeScopes, tokenStatus, tokenStatusBadge, TOKEN_EXPIRY_OPTIONS } from '@/components/settings/tokens/tokenHelpers';
import { createServiceAccountToken, getServiceAccount, revokeServiceAccountToken } from '@/services/apiTokenService';
import { getPermissionCatalog } from '@/services/roleService';
import { formatDateTime, relativeTime } from '@/utils/time';

const inputCls =
  'h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring';

function CreateTokenForm({ serviceAccountId, rolePermissions, onCreated, onCancel }) {
  const [name, setName] = useState('');
  const [expiresInDays, setExpiresInDays] = useState('365');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  // Opt-in scope limit — empty scopes = the service account's full role
  // permissions, the existing backend default. `grantable` is the service
  // account's own role permissions (GET /service-accounts/:id
  // `rolePermissions`), same idea as the personal picker using the caller's
  // own permissions: a token can never be scoped wider than its holder.
  const [limiting, setLimiting] = useState(false);
  const [scopes, setScopes] = useState([]);
  const [catalog, setCatalog] = useState(null);
  const [catalogError, setCatalogError] = useState('');
  const grantable = useMemo(() => new Set(rolePermissions || []), [rolePermissions]);

  useEffect(() => {
    getPermissionCatalog()
      .then(setCatalog)
      .catch(() => setCatalogError('Could not load the permission list. Try again.'));
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    if (!name.trim()) {
      setError('Name is required.');
      return;
    }
    setSaving(true);
    try {
      const body = { name: name.trim() };
      if (expiresInDays) body.expiresInDays = Number(expiresInDays);
      if (limiting && scopes.length > 0) body.scopes = scopes;
      const result = await createServiceAccountToken(serviceAccountId, body);
      onCreated(result);
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message || 'Failed to create token.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-3 rounded-lg border border-border p-3">
      {error && (
        <div role="alert" className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}
      <div>
        <label htmlFor="sa-token-name" className="mb-1.5 block text-sm font-medium text-foreground">
          Name <span className="text-destructive">*</span>
        </label>
        <input
          id="sa-token-name"
          className={inputCls}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. GitHub Actions"
          maxLength={100}
          autoFocus
        />
      </div>
      <div>
        <label htmlFor="sa-token-expiry" className="mb-1.5 block text-sm font-medium text-foreground">
          Expires
        </label>
        <select
          id="sa-token-expiry"
          className={inputCls}
          value={expiresInDays}
          onChange={(e) => setExpiresInDays(e.target.value)}
        >
          {TOKEN_EXPIRY_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      <SwitchField
        label="Limit this token"
        description="Narrow it to a subset of the service account's permissions, instead of everything its role allows."
        checked={limiting}
        onCheckedChange={(next) => {
          setLimiting(next);
          if (!next) setScopes([]);
        }}
        disabled={!catalog}
        bordered
      />
      {limiting && catalog && <TokenScopePicker catalog={catalog} value={scopes} onChange={setScopes} grantable={grantable} />}
      {limiting && catalog && scopes.length === 0 && (
        <p className="text-xs text-amber-600 dark:text-amber-400">
          Select at least one permission — with none checked this token still gets the full role.
        </p>
      )}
      {catalogError && <p className="text-xs text-muted-foreground">{catalogError}</p>}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={saving}>
          {saving ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
          Create token
        </Button>
      </div>
    </form>
  );
}

function TokenRow({ token, onRevoke, busy }) {
  const status = tokenStatus(token);
  const badge = tokenStatusBadge(token);
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-border p-3">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="truncate text-sm font-medium text-foreground">{token.name}</p>
          <Badge tone={badge.tone}>{badge.label}</Badge>
        </div>
        <p className="mt-1 font-mono text-xs text-muted-foreground">{token.tokenPrefix}…</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {formatTokenExpiry(token.expiresAt)}
          {' · '}
          {token.lastUsedAt ? `Last used ${relativeTime(token.lastUsedAt)}` : 'Never used'}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">Scope: {summarizeScopes(token.scopes)}</p>
        {token.revokedAt && (
          <p className="mt-1 text-xs text-muted-foreground">Revoked {formatDateTime(token.revokedAt)}</p>
        )}
      </div>
      {status !== 'revoked' && (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="shrink-0 text-destructive hover:text-destructive"
          onClick={() => onRevoke(token)}
          disabled={busy}
        >
          <Trash2 className="mr-1.5 h-3.5 w-3.5" />
          Revoke
        </Button>
      )}
    </div>
  );
}

/**
 * ServiceAccountTokensModal — manage the tokens belonging to one service
 * account (list, create, revoke). No rotate here: unlike personal tokens
 * the API only offers create/delete for service account tokens.
 *
 * Props: open, onClose, serviceAccount, onChanged(account) — called after
 * any mutation so the caller's list can refresh tokenCount / lastUsedAt.
 */
export default function ServiceAccountTokensModal({ open, onClose, serviceAccount, onChanged }) {
  const [tokens, setTokens] = useState([]);
  const [rolePermissions, setRolePermissions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [confirm, setConfirm] = useState(null); // token to revoke
  const [reveal, setReveal] = useState(null); // { token, name }

  const refresh = useCallback(() => {
    if (!serviceAccount?.id) return Promise.resolve();
    setLoading(true);
    return getServiceAccount(serviceAccount.id)
      .then((account) => {
        setTokens(account?.tokens || []);
        setRolePermissions(account?.rolePermissions || []);
        setError('');
        onChanged?.(account);
      })
      .catch((err) => setError(err.response?.data?.error?.message || err.message || 'Failed to load tokens.'))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serviceAccount?.id]);

  useEffect(() => {
    if (!open) return;
    setCreating(false);
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, serviceAccount?.id]);

  if (!open) return null;

  const handleCreated = ({ token, apiToken }) => {
    setCreating(false);
    setTokens((prev) => [apiToken, ...prev]);
    setReveal({ token, name: apiToken.name });
    refresh();
  };

  const handleRevokeConfirmed = async () => {
    const target = confirm;
    setConfirm(null);
    if (!target) return;
    setBusyId(target.id);
    try {
      await revokeServiceAccountToken(serviceAccount.id, target.id);
      await refresh();
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message || 'Failed to revoke token.');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <>
      <Modal open={open} onClose={onClose} title={`Tokens — ${serviceAccount?.name || ''}`} size="lg">
        <div className="space-y-4">
          {error && (
            <div role="alert" className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}

          {loading ? (
            <div className="space-y-2">
              {[1, 2].map((i) => (
                <div key={i} className="h-16 animate-pulse rounded-lg bg-muted" />
              ))}
            </div>
          ) : tokens.length === 0 && !creating ? (
            <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border px-6 py-8 text-center">
              <KeyRound className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
              <p className="text-sm text-muted-foreground">No tokens for this service account yet.</p>
            </div>
          ) : (
            <div className="space-y-2">
              {tokens.map((t) => (
                <TokenRow key={t.id} token={t} busy={busyId === t.id} onRevoke={setConfirm} />
              ))}
            </div>
          )}

          {creating ? (
            <CreateTokenForm
              serviceAccountId={serviceAccount.id}
              rolePermissions={rolePermissions}
              onCreated={handleCreated}
              onCancel={() => setCreating(false)}
            />
          ) : (
            <Button type="button" size="sm" onClick={() => setCreating(true)}>
              <Plus className="mr-1.5 h-4 w-4" />
              Create token
            </Button>
          )}
        </div>
      </Modal>

      <ConfirmDialog
        open={!!confirm}
        title={confirm ? `Revoke "${confirm.name}"?` : ''}
        message="Anything using this token will stop working immediately. This cannot be undone."
        confirmLabel="Revoke"
        variant="destructive"
        onConfirm={handleRevokeConfirmed}
        onCancel={() => setConfirm(null)}
      />

      <TokenRevealDialog open={!!reveal} onClose={() => setReveal(null)} token={reveal?.token} name={reveal?.name} />
    </>
  );
}
