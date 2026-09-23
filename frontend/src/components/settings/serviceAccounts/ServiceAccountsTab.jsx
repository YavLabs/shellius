import { useCallback, useEffect, useState } from 'react';
import { Bot, Building2, KeyRound, Pencil, Play, Plus, Trash2, Zap } from 'lucide-react';
import { SectionCard } from '@/components/settings/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import ConfirmDialog from '@/components/shared/ConfirmDialog';
import { useAuth } from '@/context/AuthContext';
import { relativeTime } from '@/utils/time';
import { statusTone } from '@/lib/badgeTones';
import { deleteServiceAccount, listServiceAccounts, updateServiceAccount } from '@/services/apiTokenService';
import ServiceAccountFormModal from './ServiceAccountFormModal';
import ServiceAccountTokensModal from './ServiceAccountTokensModal';

function ScopeBadge({ accessScope, customerIds }) {
  if (accessScope !== 'CUSTOMERS') {
    return (
      <Badge tone="neutral" variant="outline">
        Entire organization
      </Badge>
    );
  }
  const count = customerIds?.length || 0;
  return (
    <Badge tone="accent" variant="outline" icon={Building2}>
      {count} customer{count === 1 ? '' : 's'}
    </Badge>
  );
}

function ServiceAccountCard({ account, canManage, onEdit, onTokens, onToggleStatus, onDelete }) {
  const isActive = account.status !== 'deactivated';
  const { tone, label } = statusTone(account.status || 'active');
  return (
    <div className={['rounded-lg border bg-card p-4', isActive ? 'border-border' : 'border-border opacity-75'].join(' ')}>
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border bg-muted/40">
          <Bot className="h-4 w-4 text-foreground" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="truncate text-sm font-semibold text-foreground">{account.name}</p>
            <Badge tone={tone}>{label}</Badge>
          </div>
          {account.description && <p className="mt-0.5 truncate text-xs text-muted-foreground">{account.description}</p>}
          <p className="mt-0.5 truncate text-xs text-muted-foreground">{account.email}</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Badge tone="neutral" variant="outline">
              {account.roleName || 'No role'}
            </Badge>
            <ScopeBadge accessScope={account.accessScope} customerIds={account.customerIds} />
            <Badge tone="neutral" variant="outline" icon={KeyRound}>
              {account.tokenCount ?? 0} token{account.tokenCount === 1 ? '' : 's'}
            </Badge>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            {account.lastUsedAt ? `Last used ${relativeTime(account.lastUsedAt)}` : 'Never used'}
          </p>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-2 border-t border-border pt-3">
        <Button size="sm" variant="outline" onClick={() => onTokens(account)}>
          <KeyRound className="mr-1.5 h-3.5 w-3.5" />
          Manage tokens
        </Button>
        {canManage && (
          <>
            <Button size="sm" variant="ghost" onClick={() => onEdit(account)}>
              <Pencil className="mr-1.5 h-3.5 w-3.5" />
              Edit
            </Button>
            <Button size="sm" variant="ghost" onClick={() => onToggleStatus(account)}>
              {isActive ? (
                <>
                  <Zap className="mr-1.5 h-3.5 w-3.5" />
                  Deactivate
                </>
              ) : (
                <>
                  <Play className="mr-1.5 h-3.5 w-3.5" />
                  Reactivate
                </>
              )}
            </Button>
            <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => onDelete(account)}>
              <Trash2 className="mr-1.5 h-3.5 w-3.5" />
              Delete
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Administration → Service accounts. Org-owned machine identities (CI,
 * Terraform) — each a real user row with its own Role, customer scope and
 * tokens, distinct from a person's self-service personal access tokens
 * (Profile > Personal access tokens).
 */
export default function ServiceAccountsTab() {
  const { can } = useAuth();
  const canManage = can('service_accounts.manage');

  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [tokensFor, setTokensFor] = useState(null);
  const [confirm, setConfirm] = useState(null); // { kind: 'delete' | 'status', account }

  const refresh = useCallback(() => {
    setLoading(true);
    return listServiceAccounts()
      .then((list) => {
        setAccounts(list || []);
        setError('');
      })
      .catch((err) => setError(err.response?.data?.error?.message || err.message || 'Failed to load service accounts.'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const runAction = async (fn) => {
    setError('');
    try {
      await fn();
      await refresh();
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message || 'Action failed.');
    }
  };

  const handleConfirm = async () => {
    const { kind, account } = confirm || {};
    setConfirm(null);
    if (kind === 'delete') {
      await runAction(() => deleteServiceAccount(account.id));
    } else if (kind === 'status') {
      const nextStatus = account.status === 'deactivated' ? 'active' : 'deactivated';
      await runAction(() => updateServiceAccount(account.id, { status: nextStatus }));
    }
  };

  const confirmCopy = (() => {
    if (!confirm) return {};
    const { kind, account } = confirm;
    if (kind === 'delete') {
      return {
        title: `Delete ${account.name}?`,
        message:
          `This permanently removes the "${account.name}" service account and revokes every token it holds` +
          `${account.tokenCount ? ` (${account.tokenCount} active)` : ''}. Anything authenticating with those tokens` +
          ' — CI pipelines, Terraform runs, and so on — will start failing immediately. This cannot be undone.',
        confirmLabel: 'Delete',
        variant: 'destructive',
      };
    }
    const deactivating = account.status !== 'deactivated';
    return deactivating
      ? {
          title: `Deactivate ${account.name}?`,
          message: 'Its tokens stop authenticating immediately. Reactivate it later to restore them without re-issuing new ones.',
          confirmLabel: 'Deactivate',
          variant: 'destructive',
        }
      : {
          title: `Reactivate ${account.name}?`,
          message: 'Its existing tokens will authenticate again.',
          confirmLabel: 'Reactivate',
        };
  })();

  return (
    <SectionCard
      title="Service accounts"
      description="Org-owned machine identities for CI and automation — each holds its own role, customer scope and tokens."
      actions={
        canManage && (
          <Button
            size="sm"
            onClick={() => {
              setEditing(null);
              setFormOpen(true);
            }}
          >
            <Plus className="mr-1.5 h-4 w-4" />
            Add service account
          </Button>
        )
      }
    >
      <div className="space-y-4">
        {error && (
          <div role="alert" className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        {loading ? (
          <div className="space-y-2 py-2">
            {[1, 2].map((i) => (
              <div key={i} className="h-28 animate-pulse rounded-lg bg-muted" />
            ))}
          </div>
        ) : accounts.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border px-6 py-10 text-center">
            <Bot className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
            <p className="text-sm font-medium text-foreground">No service accounts yet</p>
            <p className="max-w-md text-xs text-muted-foreground">
              Create one for a CI pipeline or automation tool that needs its own tokens and access.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {accounts.map((a) => (
              <ServiceAccountCard
                key={a.id}
                account={a}
                canManage={canManage}
                onEdit={(acc) => {
                  setEditing(acc);
                  setFormOpen(true);
                }}
                onTokens={setTokensFor}
                onToggleStatus={(acc) => setConfirm({ kind: 'status', account: acc })}
                onDelete={(acc) => setConfirm({ kind: 'delete', account: acc })}
              />
            ))}
          </div>
        )}
      </div>

      <ServiceAccountFormModal
        open={formOpen}
        onClose={() => setFormOpen(false)}
        serviceAccount={editing}
        onSaved={(saved) => {
          setFormOpen(false);
          refresh();
        }}
      />

      <ServiceAccountTokensModal
        open={!!tokensFor}
        onClose={() => setTokensFor(null)}
        serviceAccount={tokensFor}
        onChanged={(updated) => {
          setAccounts((prev) => prev.map((a) => (a.id === updated?.id ? { ...a, tokenCount: updated.tokens?.length ?? a.tokenCount, lastUsedAt: updated.lastUsedAt ?? a.lastUsedAt } : a)));
        }}
      />

      <ConfirmDialog
        open={!!confirm}
        title={confirmCopy.title}
        message={confirmCopy.message}
        confirmLabel={confirmCopy.confirmLabel}
        variant={confirmCopy.variant}
        onConfirm={handleConfirm}
        onCancel={() => setConfirm(null)}
      />
    </SectionCard>
  );
}
