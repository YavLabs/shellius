import { useState } from 'react';
import { ArrowDown, ArrowUp, MoreHorizontal, Users, Wifi } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Badge } from '@/components/ui/badge';
import ConfirmDialog from '@/components/shared/ConfirmDialog';
import { CopyButton } from '@/components/settings/shared';
import ProviderIcon from './ProviderIcon';
import { getProvider } from '@/config/ssoProviders';
import {
  updateSsoProvider,
  deleteSsoProvider,
  testSavedSsoProvider,
  reorderSsoProviders,
} from '@/services/ssoConfigService';

function allowedSummary(provider) {
  const parts = [];
  if (provider.allowedDomains?.length) parts.push(`${provider.allowedDomains.length} domain${provider.allowedDomains.length === 1 ? '' : 's'}`);
  if (provider.allowedOrgs?.length) parts.push(`${provider.allowedOrgs.length} org${provider.allowedOrgs.length === 1 ? '' : 's'}`);
  if (!parts.length) return 'Any';
  return parts.join(', ');
}

function ProviderRow({ provider, index, count, onChanged, onEdit }) {
  const preset = getProvider(provider.presetId);
  const [busy, setBusy] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteError, setDeleteError] = useState(null); // { message, forceable }
  const [deleting, setDeleting] = useState(false);

  const handleToggleActive = async () => {
    setBusy(true);
    try {
      await updateSsoProvider(provider.id, { isActive: !provider.isActive });
      onChanged();
    } catch {
      /* surfaced via list refresh no-op; row stays as-is */
    } finally {
      setBusy(false);
    }
  };

  const handleMove = async (direction) => {
    const newIndex = index + direction;
    if (newIndex < 0 || newIndex >= count) return;
    onChanged({ moveId: provider.id, direction });
  };

  const handleTest = async () => {
    setBusy(true);
    setTestResult(null);
    try {
      const result = await testSavedSsoProvider(provider.id);
      setTestResult({ ok: result?.ok !== false, message: result?.message });
    } catch (err) {
      setTestResult({ ok: false, message: err.response?.data?.error?.message || err.message || 'Test failed' });
    } finally {
      setBusy(false);
      setTimeout(() => setTestResult(null), 6000);
    }
  };

  const runDelete = async (force) => {
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteSsoProvider(provider.id, { force });
      setConfirmDelete(false);
      onChanged();
    } catch (err) {
      const code = err.response?.data?.error?.code;
      if (code === 'LAST_SIGN_IN_METHOD') {
        setDeleteError({
          message:
            err.response?.data?.error?.message ||
            'One or more users would be left with no way to sign in if this provider is removed.',
          forceable: true,
        });
      } else {
        setDeleteError({
          message: err.response?.data?.error?.message || err.message || 'Failed to delete provider',
          forceable: false,
        });
      }
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 border-b border-border py-4 last:border-0 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-start gap-3">
        <div className="flex shrink-0 flex-col items-center gap-0.5 pt-0.5">
          <button
            type="button"
            disabled={index === 0}
            onClick={() => handleMove(-1)}
            aria-label="Move up"
            className="rounded p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:hover:text-muted-foreground"
          >
            <ArrowUp className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            disabled={index === count - 1}
            onClick={() => handleMove(1)}
            aria-label="Move down"
            className="rounded p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:hover:text-muted-foreground"
          >
            <ArrowDown className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border bg-muted/40">
          <ProviderIcon presetId={provider.presetId} className="h-4 w-4 text-foreground" />
        </div>

        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="truncate text-sm font-semibold text-foreground">{provider.name}</p>
            <Badge tone="neutral" variant="outline" className="shrink-0">
              {preset?.label || provider.presetId}
            </Badge>
            {provider.source === 'env' && (
              <Badge tone="info" className="shrink-0">
                Environment
              </Badge>
            )}
            {provider.isActive ? (
              <Badge tone="success" dot className="shrink-0">Active</Badge>
            ) : (
              <Badge tone="neutral" className="shrink-0">Inactive</Badge>
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span className="flex items-center gap-1">
              <Users className="h-3 w-3" /> {provider.userCount ?? 0} user{provider.userCount === 1 ? '' : 's'}
            </span>
            <span>Allowed: {allowedSummary(provider)}</span>
            {provider.callbackUrl && (
              <span className="flex items-center gap-1 truncate">
                <span className="truncate font-mono">{provider.callbackUrl}</span>
                <CopyButton text={provider.callbackUrl} />
              </span>
            )}
          </div>
          {testResult && (
            <p className={`mt-1 text-xs ${testResult.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive'}`}>
              {testResult.ok ? 'Connection successful' : (testResult.message || 'Connection failed')}
            </p>
          )}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2 self-end sm:self-center">
        <button
          role="switch"
          aria-checked={provider.isActive}
          type="button"
          disabled={busy || provider.source === 'env'}
          onClick={handleToggleActive}
          title={provider.source === 'env' ? 'Configured via environment variables' : 'Toggle active'}
          className={[
            'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
            provider.isActive ? 'bg-primary' : 'bg-muted-foreground/30',
          ].join(' ')}
        >
          <span
            className={[
              'pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out',
              provider.isActive ? 'translate-x-4' : 'translate-x-0',
            ].join(' ')}
          />
        </button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              disabled={provider.source === 'env'}
              className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
              aria-label={`Actions for ${provider.name}`}
            >
              <MoreHorizontal className="h-4 w-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => onEdit(provider)}>Edit</DropdownMenuItem>
            <DropdownMenuItem onClick={handleTest}>
              <Wifi className="mr-2 h-3.5 w-3.5" /> Test connection
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => setConfirmDelete(true)}
              className="text-destructive focus:text-destructive"
            >
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        title={`Delete ${provider.name}?`}
        message={
          deleteError
            ? deleteError.message
            : `Users who signed in via ${provider.name} keep their accounts, but this provider's linked identities are removed and it disappears from the login page.`
        }
        confirmLabel={deleting ? 'Deleting…' : deleteError?.forceable ? 'Delete anyway' : 'Delete provider'}
        variant="destructive"
        onConfirm={() => runDelete(!!deleteError?.forceable)}
        onCancel={() => {
          setConfirmDelete(false);
          setDeleteError(null);
        }}
      />
    </div>
  );
}

/**
 * ProviderList — configured SSO providers with status toggle, up/down
 * reorder, and a row menu (Edit / Test connection / Delete). `onChanged`
 * is called after any mutation so SsoTab can refetch the list; when called
 * with `{ moveId, direction }` it performs the reorder API call itself.
 */
export default function ProviderList({ providers, onEdit, onChanged }) {
  const [reordering, setReordering] = useState(false);

  const handleChanged = async (moveInfo) => {
    if (!moveInfo) {
      onChanged();
      return;
    }
    const { moveId, direction } = moveInfo;
    const ids = providers.map((p) => p.id);
    const idx = ids.indexOf(moveId);
    const newIdx = idx + direction;
    if (idx < 0 || newIdx < 0 || newIdx >= ids.length) return;
    const reordered = [...ids];
    [reordered[idx], reordered[newIdx]] = [reordered[newIdx], reordered[idx]];
    setReordering(true);
    try {
      await reorderSsoProviders(reordered);
    } finally {
      setReordering(false);
      onChanged();
    }
  };

  if (!providers.length) return null;

  return (
    <div className={reordering ? 'opacity-60 transition-opacity' : ''}>
      {providers.map((provider, index) => (
        <ProviderRow
          key={provider.id}
          provider={provider}
          index={index}
          count={providers.length}
          onEdit={onEdit}
          onChanged={handleChanged}
        />
      ))}
    </div>
  );
}
