import { useCallback, useEffect, useMemo, useState } from 'react';
import { KeyRound, Loader2, Plus, RotateCw, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { SwitchField } from '@/components/ui/switch';
import ConfirmDialog from '@/components/shared/ConfirmDialog';
import TokenRevealDialog from '@/components/settings/tokens/TokenRevealDialog';
import TokenScopePicker from '@/components/settings/tokens/TokenScopePicker';
import { formatTokenExpiry, summarizeScopes, tokenStatus, tokenStatusBadge, TOKEN_EXPIRY_OPTIONS } from '@/components/settings/tokens/tokenHelpers';
import { createMyToken, listMyTokens, revokeMyToken, rotateMyToken } from '@/services/apiTokenService';
import { getPermissionCatalog } from '@/services/roleService';
import { useAuth } from '@/context/AuthContext';
import { formatDateTime, relativeTime } from '@/utils/time';

const inputCls =
  'h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring';

function SectionCard({ title, description, children }) {
  return (
    <div className="rounded-lg border border-border bg-card p-6">
      <div className="mb-5">
        <h2 className="text-base font-semibold text-foreground">{title}</h2>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>
      {children}
    </div>
  );
}

/** New-token form — name, optional description, an "expires in" picker and an opt-in scope limit. */
function CreateTokenForm({ onCreated, onCancel }) {
  const { user } = useAuth();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [expiresInDays, setExpiresInDays] = useState('90');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  // Opt-in scope limit — off by default (empty scopes = full owner
  // permissions, the existing backend behaviour). GET /roles/catalog accepts
  // tokens.personal (as well as roles.view / users.assign_role), so anyone
  // who can mint a personal token can load it; a catalogue load failure here
  // is a genuine error (network, server), not a permission gap, and just
  // disables the limit toggle rather than blocking token creation.
  const [limiting, setLimiting] = useState(false);
  const [scopes, setScopes] = useState([]);
  const [catalog, setCatalog] = useState(null);
  const [catalogError, setCatalogError] = useState('');
  const [catalogLoading, setCatalogLoading] = useState(true);
  const grantable = useMemo(() => new Set(user?.permissions || []), [user?.permissions]);

  useEffect(() => {
    getPermissionCatalog()
      .then(setCatalog)
      .catch(() => setCatalogError('Could not load the permission list. Try again.'))
      .finally(() => setCatalogLoading(false));
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
      if (description.trim()) body.description = description.trim();
      if (expiresInDays) body.expiresInDays = Number(expiresInDays);
      if (limiting && scopes.length > 0) body.scopes = scopes;
      const result = await createMyToken(body);
      onCreated(result);
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message || 'Failed to create token.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-3 rounded-lg border border-border p-4">
      {error && (
        <div role="alert" className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}
      <div>
        <label htmlFor="token-name" className="mb-1.5 block text-sm font-medium text-foreground">
          Name <span className="text-destructive">*</span>
        </label>
        <input
          id="token-name"
          className={inputCls}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. laptop CLI"
          maxLength={100}
          autoFocus
        />
      </div>
      <div>
        <label htmlFor="token-description" className="mb-1.5 block text-sm font-medium text-foreground">
          Description <span className="text-muted-foreground">(optional)</span>
        </label>
        <input
          id="token-description"
          className={inputCls}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What is this token for?"
          maxLength={250}
        />
      </div>
      <div>
        <label htmlFor="token-expiry" className="mb-1.5 block text-sm font-medium text-foreground">
          Expires
        </label>
        <select
          id="token-expiry"
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
      <p className="text-xs text-muted-foreground">
        This token can do only what your current role can do — if your role changes later, so does what it can
        access.
      </p>

      <SwitchField
        label="Limit this token"
        description="Narrow it to a subset of your permissions, instead of everything your role allows."
        checked={limiting}
        onCheckedChange={(next) => {
          setLimiting(next);
          if (!next) setScopes([]);
        }}
        disabled={!catalog}
        bordered
      />
      {limiting && catalog && (
        <TokenScopePicker catalog={catalog} value={scopes} onChange={setScopes} grantable={grantable} />
      )}
      {limiting && catalog && scopes.length === 0 && (
        <p className="text-xs text-amber-600 dark:text-amber-400">
          Select at least one permission — with none checked this token still gets your full role.
        </p>
      )}
      {!catalogLoading && catalogError && <p className="text-xs text-muted-foreground">{catalogError}</p>}

      <div className="flex justify-end gap-2 pt-1">
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

function TokenRow({ token, onRotate, onRevoke, busy }) {
  const status = tokenStatus(token);
  const badge = tokenStatusBadge(token);
  const usable = status === 'active';
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-border p-3">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="truncate text-sm font-medium text-foreground">{token.name}</p>
          <Badge tone={badge.tone}>{badge.label}</Badge>
        </div>
        {token.description && <p className="mt-0.5 text-xs text-muted-foreground">{token.description}</p>}
        <p className="mt-1 font-mono text-xs text-muted-foreground">{token.tokenPrefix}…</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {formatTokenExpiry(token.expiresAt)}
          {' · '}
          {token.lastUsedAt ? `Last used ${relativeTime(token.lastUsedAt)}` : 'Never used'}
          {token.lastUsedIp ? ` from ${token.lastUsedIp}` : ''}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">Scope: {summarizeScopes(token.scopes)}</p>
        {token.revokedAt && (
          <p className="mt-1 text-xs text-muted-foreground">Revoked {formatDateTime(token.revokedAt)}</p>
        )}
      </div>
      <div className="flex shrink-0 gap-2">
        {usable && (
          <Button type="button" size="sm" variant="outline" onClick={() => onRotate(token)} disabled={busy}>
            <RotateCw className="mr-1.5 h-3.5 w-3.5" />
            Rotate
          </Button>
        )}
        {status !== 'revoked' && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="text-destructive hover:text-destructive"
            onClick={() => onRevoke(token)}
            disabled={busy}
          >
            <Trash2 className="mr-1.5 h-3.5 w-3.5" />
            Revoke
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * ApiTokensCard — self-service personal access tokens (Profile page).
 * A personal token's permissions are always narrowed to the holder's live
 * role, so it can never do more than the person who minted it — see
 * services/apiTokenService.js and TokenRevealDialog for the one-time reveal.
 */
export default function ApiTokensCard() {
  const [tokens, setTokens] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [confirm, setConfirm] = useState(null); // { kind: 'revoke' | 'rotate', token }
  const [reveal, setReveal] = useState(null); // { token, name, subtitle }

  const refresh = useCallback(() => {
    setLoading(true);
    return listMyTokens()
      .then((list) => {
        setTokens(list || []);
        setError('');
      })
      .catch((err) => setError(err.response?.data?.error?.message || err.message || 'Failed to load tokens.'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleCreated = ({ token, apiToken }) => {
    setCreating(false);
    setTokens((prev) => [apiToken, ...prev]);
    setReveal({ token, name: apiToken.name });
  };

  const handleRotateConfirmed = async () => {
    const target = confirm?.token;
    setConfirm(null);
    if (!target) return;
    setBusyId(target.id);
    try {
      const { token, apiToken } = await rotateMyToken(target.id);
      setTokens((prev) => prev.map((t) => (t.id === apiToken.id ? apiToken : t)));
      setReveal({ token, name: apiToken.name, subtitle: 'Rotated — the previous value stopped working immediately.' });
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message || 'Failed to rotate token.');
    } finally {
      setBusyId(null);
    }
  };

  const handleRevokeConfirmed = async () => {
    const target = confirm?.token;
    setConfirm(null);
    if (!target) return;
    setBusyId(target.id);
    try {
      await revokeMyToken(target.id);
      await refresh();
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message || 'Failed to revoke token.');
    } finally {
      setBusyId(null);
    }
  };

  const confirmCopy = (() => {
    if (!confirm) return {};
    if (confirm.kind === 'rotate') {
      return {
        title: `Rotate "${confirm.token.name}"?`,
        message: 'A new value is issued and shown once. The current value stops working immediately.',
        confirmLabel: 'Rotate',
        onConfirm: handleRotateConfirmed,
      };
    }
    return {
      title: `Revoke "${confirm.token.name}"?`,
      message: 'Anything using this token will stop working immediately. This cannot be undone.',
      confirmLabel: 'Revoke',
      variant: 'destructive',
      onConfirm: handleRevokeConfirmed,
    };
  })();

  return (
    <SectionCard
      title="Personal access tokens"
      description="Long-lived bearer tokens for your own scripts. They can never do more than your current role allows."
    >
      {error && (
        <div className="mb-3 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
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
          <p className="text-sm text-muted-foreground">No personal access tokens yet.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {tokens.map((t) => (
            <TokenRow
              key={t.id}
              token={t}
              busy={busyId === t.id}
              onRotate={(token) => setConfirm({ kind: 'rotate', token })}
              onRevoke={(token) => setConfirm({ kind: 'revoke', token })}
            />
          ))}
        </div>
      )}

      {creating ? (
        <div className="mt-3">
          <CreateTokenForm onCreated={handleCreated} onCancel={() => setCreating(false)} />
        </div>
      ) : (
        <div className="mt-4">
          <Button type="button" size="sm" onClick={() => setCreating(true)}>
            <Plus className="mr-1.5 h-4 w-4" />
            Create token
          </Button>
        </div>
      )}

      <ConfirmDialog
        open={!!confirm}
        title={confirmCopy.title}
        message={confirmCopy.message}
        confirmLabel={confirmCopy.confirmLabel}
        variant={confirmCopy.variant}
        onConfirm={confirmCopy.onConfirm}
        onCancel={() => setConfirm(null)}
      />

      <TokenRevealDialog
        open={!!reveal}
        onClose={() => setReveal(null)}
        token={reveal?.token}
        name={reveal?.name}
        subtitle={reveal?.subtitle}
      />
    </SectionCard>
  );
}
