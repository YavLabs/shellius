import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Lock, CheckCircle2, Loader2, X } from 'lucide-react';
import ConfirmDialog from '@/components/shared/ConfirmDialog';
import ProviderIcon from '@/components/settings/sso/ProviderIcon';
import { Button } from '@/components/ui/button';
import { unlinkIdentity, listConnectableProviders, startConnect } from '@/services/ssoConfigService';
import { useAuth } from '@/context/AuthContext';
import { formatDateTime } from '@/utils/time';

// `/profile?connect_error=<code>` after a Profile "connect" round-trip.
const CONNECT_ERRORS = {
  identity_in_use: 'That account is already linked to another Shellius user.',
  already_connected: 'You already have an account from this provider connected.',
  domain_not_allowed: "That account's email domain isn't allowed for this organization.",
  org_not_allowed: "That GitHub account isn't a member of an allowed organization.",
  email_not_verified: "The provider didn't confirm that account's email address.",
  account_disabled: 'Your account is not active.',
  state_mismatch: 'The connect request expired or was opened in another tab. Please try again.',
  sso_not_configured: 'That sign-in provider is no longer available.',
  sso_failed: 'Something went wrong connecting the account. Nothing was changed — please try again.',
};

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

function Banner({ tone, children, onClose }) {
  const cls =
    tone === 'error'
      ? 'border-destructive/50 bg-destructive/10 text-destructive'
      : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300';
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={`mb-4 flex items-start justify-between gap-3 rounded-md border px-3 py-2 text-sm ${cls}`}>
      <span>{children}</span>
      <button type="button" onClick={onClose} aria-label="Dismiss" className="shrink-0 opacity-70 hover:opacity-100">
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

function IdentityRow({ identity, onUnlinked }) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const runUnlink = async () => {
    setBusy(true);
    setError(null);
    try {
      await unlinkIdentity(identity.id);
      setConfirmOpen(false);
      onUnlinked(identity);
    } catch (err) {
      const code = err.response?.data?.error?.code;
      setError(
        code === 'LAST_SIGN_IN_METHOD'
          ? 'Disconnecting this would leave you with no way to sign in — set a password or connect another provider first.'
          : err.response?.data?.error?.message || 'Failed to disconnect this account.'
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center justify-between gap-3 py-3">
      <div className="flex min-w-0 items-center gap-3">
        <ProviderIcon presetId={identity.presetId} className="h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-foreground">{identity.providerName}</p>
          <p className="truncate text-xs text-muted-foreground">
            {identity.email || 'Connected'}
            {identity.lastLoginAt ? ` · last used ${formatDateTime(identity.lastLoginAt)}` : ''}
          </p>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <span className="hidden items-center gap-1 text-xs font-medium text-emerald-600 dark:text-emerald-400 sm:flex">
          <CheckCircle2 className="h-3.5 w-3.5" /> Connected
        </span>
        <Button variant="outline" size="sm" onClick={() => setConfirmOpen(true)}>
          Disconnect
        </Button>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        title={`Disconnect ${identity.providerName}?`}
        message={error || `You'll no longer be able to sign in with ${identity.providerName}${identity.email ? ` (${identity.email})` : ''}.`}
        confirmLabel={busy ? 'Disconnecting…' : 'Disconnect'}
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

function ProviderRow({ provider, onError }) {
  const [busy, setBusy] = useState(false);
  const connect = async () => {
    setBusy(true);
    try {
      const { url } = await startConnect(provider.id);
      window.location.href = url;
    } catch (err) {
      setBusy(false);
      onError(err.response?.data?.error?.message || err.message || 'Could not start connecting this provider.');
    }
  };
  return (
    <div className="flex items-center justify-between gap-3 py-3">
      <div className="flex min-w-0 items-center gap-3">
        <ProviderIcon presetId={provider.presetId} className="h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-foreground">{provider.name}</p>
          <p className="truncate text-xs text-muted-foreground">Not connected</p>
        </div>
      </div>
      <Button variant="outline" size="sm" onClick={connect} disabled={busy}>
        {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
        Connect
      </Button>
    </div>
  );
}

/**
 * SignInMethodsCard — how this account can sign in: password status, every
 * active SSO provider of the org (Connect), and each linked identity
 * (Disconnect). Connecting is a round-trip to the provider that links the
 * account to YOU (never by email) and returns here with ?connected=<name>
 * or ?connect_error=<code> (docs/auth-hardening.md "Linking SSO accounts").
 */
export default function SignInMethodsCard({ hasPassword }) {
  const { user, refreshUser } = useAuth();
  const identities = user?.identities || [];
  const [providers, setProviders] = useState([]);
  const [banner, setBanner] = useState(null); // { tone, text }
  const [searchParams, setSearchParams] = useSearchParams();

  useEffect(() => {
    listConnectableProviders()
      .then(setProviders)
      .catch(() => setProviders([]));
  }, []);

  // Result of a connect round-trip — show it once, then clean the URL.
  useEffect(() => {
    const connected = searchParams.get('connected');
    const connectError = searchParams.get('connect_error');
    if (!connected && !connectError) return;
    if (connected) {
      setBanner({ tone: 'success', text: `${connected} connected. You can now sign in with it.` });
      refreshUser?.();
    } else {
      setBanner({ tone: 'error', text: CONNECT_ERRORS[connectError] || CONNECT_ERRORS.sso_failed });
    }
    const next = new URLSearchParams(searchParams);
    next.delete('connected');
    next.delete('connect_error');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams, refreshUser]);

  const linkedProviderIds = new Set(identities.map((i) => i.providerId));
  const connectable = providers.filter((p) => !linkedProviderIds.has(p.id));

  return (
    <SectionCard title="Sign-in methods" description="How you can sign in to your account.">
      {banner && (
        <Banner tone={banner.tone} onClose={() => setBanner(null)}>
          {banner.text}
        </Banner>
      )}
      <div className="divide-y divide-border">
        <div className="flex items-center justify-between gap-3 py-3">
          <div className="flex items-center gap-3">
            <Lock className="h-4 w-4 shrink-0 text-muted-foreground" />
            <p className="text-sm font-medium text-foreground">Password</p>
          </div>
          {hasPassword ? (
            <span className="flex items-center gap-1 text-xs font-medium text-emerald-600 dark:text-emerald-400">
              <CheckCircle2 className="h-3.5 w-3.5" /> Set
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">Not set</span>
          )}
        </div>
        {identities.map((identity) => (
          <IdentityRow
            key={identity.id}
            identity={identity}
            onUnlinked={(i) => {
              setBanner({ tone: 'success', text: `${i.providerName} disconnected.` });
              refreshUser?.();
            }}
          />
        ))}
        {connectable.map((provider) => (
          <ProviderRow key={provider.id} provider={provider} onError={(text) => setBanner({ tone: 'error', text })} />
        ))}
      </div>
    </SectionCard>
  );
}
