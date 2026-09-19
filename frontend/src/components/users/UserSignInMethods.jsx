import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Loader2, Lock } from 'lucide-react';
import ConfirmDialog from '@/components/shared/ConfirmDialog';
import ProviderIcon from '@/components/settings/sso/ProviderIcon';
import { Button } from '@/components/ui/button';
import { getUserIdentities, unlinkUserIdentity } from '@/services/userService';
import { formatDateTime } from '@/utils/time';

/**
 * UserSignInMethods — admin view of another user's sign-in methods
 * (users.manage_identities): whether they have a password and which SSO
 * accounts are linked, each unlinkable. The backend applies the same
 * no-escalation rule as editing the user and refuses to remove the last way
 * to sign in; the user is emailed when an account is unlinked.
 */
export default function UserSignInMethods({ user, onClose }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [target, setTarget] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    return getUserIdentities(user.id)
      .then(setData)
      .catch((err) => setError(err.response?.data?.error?.message || err.message || 'Failed to load sign-in methods'))
      .finally(() => setLoading(false));
  }, [user.id]);

  useEffect(() => {
    load();
  }, [load]);

  const unlink = async () => {
    setBusy(true);
    setError('');
    try {
      await unlinkUserIdentity(user.id, target.id);
      setMessage(`${target.providerName} unlinked. ${user.name || 'The user'} was notified by email.`);
      setTarget(null);
      await load();
    } catch (err) {
      const code = err.response?.data?.error?.code;
      setTarget(null);
      setError(
        code === 'LAST_SIGN_IN_METHOD'
          ? 'This is their only way to sign in — they need a password or another linked account first.'
          : err.response?.data?.error?.message || err.message || 'Failed to unlink'
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        How <span className="font-medium text-foreground">{user.name || user.email}</span> can sign in.
      </p>

      {error && (
        <div role="alert" className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}
      {message && (
        <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300">
          {message}
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-6">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : (
        data && (
          <div className="divide-y divide-border rounded-md border border-border px-4">
            <div className="flex items-center justify-between gap-3 py-3">
              <div className="flex items-center gap-3">
                <Lock className="h-4 w-4 text-muted-foreground" />
                <div>
                  <p className="text-sm font-medium text-foreground">Password</p>
                  {data.hasPassword && !data.passwordUsable && (
                    <p className="text-xs text-amber-600 dark:text-amber-400">Not usable — the organization requires single sign-on</p>
                  )}
                </div>
              </div>
              {data.hasPassword ? (
                <span className="flex items-center gap-1 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                  <CheckCircle2 className="h-3.5 w-3.5" /> Set
                </span>
              ) : (
                <span className="text-xs text-muted-foreground">Not set</span>
              )}
            </div>
            {data.identities.length === 0 && (
              <p className="py-3 text-sm text-muted-foreground">No single sign-on accounts linked.</p>
            )}
            {data.identities.map((identity) => (
              <div key={identity.id} className="flex items-center justify-between gap-3 py-3">
                <div className="flex min-w-0 items-center gap-3">
                  <ProviderIcon presetId={identity.presetId} className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">{identity.providerName}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {identity.email || '—'}
                      {identity.createdAt ? ` · linked ${formatDateTime(identity.createdAt)}` : ''}
                      {identity.lastLoginAt ? ` · last used ${formatDateTime(identity.lastLoginAt)}` : ''}
                    </p>
                  </div>
                </div>
                <Button variant="outline" size="sm" onClick={() => setTarget(identity)}>
                  Unlink
                </Button>
              </div>
            ))}
          </div>
        )
      )}

      <div className="flex justify-end">
        <Button variant="outline" size="sm" onClick={onClose}>
          Close
        </Button>
      </div>

      <ConfirmDialog
        open={!!target}
        title={`Unlink ${target?.providerName || ''}?`}
        message={`${user.name || 'This user'} will no longer be able to sign in with ${target?.providerName || 'this account'}${target?.email ? ` (${target.email})` : ''}. They will be notified by email.`}
        confirmLabel={busy ? 'Unlinking…' : 'Unlink'}
        variant="destructive"
        onConfirm={unlink}
        onCancel={() => setTarget(null)}
      />
    </div>
  );
}
