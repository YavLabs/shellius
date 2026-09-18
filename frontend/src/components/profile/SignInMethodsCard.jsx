import { useState } from 'react';
import { KeyRound, Lock, CheckCircle2 } from 'lucide-react';
import ConfirmDialog from '@/components/shared/ConfirmDialog';
import ProviderIcon from '@/components/settings/sso/ProviderIcon';
import { unlinkIdentity } from '@/services/ssoConfigService';
import { useAuth } from '@/context/AuthContext';
import { formatDateTime } from '@/utils/time';

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

function Row({ icon: Icon, label, active, detail, action }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border py-3 last:border-0">
      <div className="flex items-center gap-3 min-w-0">
        <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-foreground">{label}</p>
          {detail && <p className="truncate text-xs text-muted-foreground">{detail}</p>}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        {active ? (
          <span className="flex items-center gap-1 text-xs font-medium text-emerald-600 dark:text-emerald-400">
            <CheckCircle2 className="h-3.5 w-3.5" /> Active
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">Not set up</span>
        )}
        {action}
      </div>
    </div>
  );
}

function IdentityRow({ identity, onUnlinked }) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [error, setError] = useState(null); // { message, forceable }
  const [busy, setBusy] = useState(false);

  const runUnlink = async () => {
    setBusy(true);
    setError(null);
    try {
      await unlinkIdentity(identity.id);
      setConfirmOpen(false);
      onUnlinked();
    } catch (err) {
      const code = err.response?.data?.error?.code;
      setError({
        message:
          err.response?.data?.error?.message ||
          (code === 'LAST_SIGN_IN_METHOD'
            ? "Unlinking this would leave you with no way to sign in — set a password or link another provider first."
            : 'Failed to unlink this identity.'),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center justify-between gap-3 border-b border-border py-3 last:border-0">
      <div className="flex min-w-0 items-center gap-3">
        <ProviderIcon presetId={identity.presetId} className="h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-foreground">{identity.providerName}</p>
          <p className="truncate text-xs text-muted-foreground">
            {identity.email}
            {identity.lastLoginAt ? ` · last used ${formatDateTime(identity.lastLoginAt)}` : ''}
          </p>
        </div>
      </div>
      <button
        type="button"
        onClick={() => setConfirmOpen(true)}
        className="shrink-0 text-xs font-medium text-muted-foreground hover:text-destructive"
      >
        Unlink
      </button>

      <ConfirmDialog
        open={confirmOpen}
        title={`Unlink ${identity.providerName}?`}
        message={error?.message || `You'll no longer be able to sign in with ${identity.providerName}.`}
        confirmLabel={busy ? 'Unlinking…' : 'Unlink'}
        variant="destructive"
        onConfirm={runUnlink}
        onCancel={() => {
          setConfirmOpen(false);
          setError(null);
        }}
      />
    </div>
  );
}

/**
 * SignInMethodsCard — how this account can sign in: password status, and one
 * row per linked SSO identity (from /auth/me `identities`), each unlinkable.
 */
export default function SignInMethodsCard({ hasPassword, ssoProvider }) {
  const { user, refreshUser } = useAuth();
  const identities = user?.identities || [];

  return (
    <SectionCard title="Sign-in methods" description="How you can sign in to your account.">
      <div className="divide-y divide-border">
        <Row icon={Lock} label="Password" active={!!hasPassword} />
        {identities.length > 0 ? (
          identities.map((identity) => (
            <IdentityRow key={identity.id} identity={identity} onUnlinked={refreshUser} />
          ))
        ) : (
          <Row
            icon={KeyRound}
            label="Single sign-on"
            active={!!ssoProvider}
            detail={ssoProvider ? `Linked via ${ssoProvider}` : undefined}
          />
        )}
      </div>
    </SectionCard>
  );
}
