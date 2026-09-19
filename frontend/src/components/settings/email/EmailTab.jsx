import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Plus, Mail, Send, Pencil, Trash2, CheckCircle2, AlertTriangle, Info, Link2 } from 'lucide-react';
import { SectionCard } from '@/components/settings/shared';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import ConfirmDialog from '@/components/shared/ConfirmDialog';
import { useAuth } from '@/context/AuthContext';
import { relativeTime, formatDateTime } from '@/utils/time';
import {
  listEmailProviders,
  deleteEmailProvider,
  activateEmailProvider,
  deactivateEmailProvider,
  connectGoogleEmailProvider,
} from '@/services/emailProviderService';
import { getEmailProviderType } from './providerTypes';
import EmailProviderFormModal from './EmailProviderFormModal';
import TestEmailModal from './TestEmailModal';

// ?error= codes from the Google OAuth callback (routes/emailProviders.js).
const GOOGLE_ERRORS = {
  invalid_state: 'The Google sign-in link expired or was already used. Click “Connect Google account” again.',
  access_denied: 'Google access was declined.',
  scope_missing: 'Google did not grant permission to send email. Connect again and allow “Send email on your behalf”.',
  exchange_failed: 'Google rejected the sign-in. Check the client ID, secret and redirect URI, then try again.',
  client_not_configured: 'Set the Google OAuth client ID and secret first.',
  forbidden: 'You no longer have permission to manage email settings.',
  provider_not_found: 'That email provider no longer exists.',
  missing_code: 'Google did not return an authorization code.',
  google_error: 'Google returned an error.',
  server_error: 'Something went wrong while connecting the Google account.',
};

function Notice({ tone = 'info', icon: Icon = Info, children }) {
  const tones = {
    info: 'border-blue-500/40 bg-blue-500/10 text-blue-700 dark:text-blue-300',
    warning: 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300',
    success: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
    danger: 'border-destructive/50 bg-destructive/10 text-destructive',
  };
  return (
    <div className={`flex items-start gap-2 rounded-md border px-3 py-2 text-sm ${tones[tone]}`}>
      <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function TestStatus({ provider }) {
  if (!provider.lastTestAt) return <span className="text-xs text-muted-foreground">Not tested yet</span>;
  if (provider.lastTestOk) {
    return (
      <Badge tone="success" dot title={formatDateTime(provider.lastTestAt)}>
        Test passed · {relativeTime(provider.lastTestAt)}
      </Badge>
    );
  }
  return (
    <div className="min-w-0 space-y-1">
      <Badge tone="danger" dot title={formatDateTime(provider.lastTestAt)}>
        Test failed · {relativeTime(provider.lastTestAt)}
      </Badge>
      {provider.lastTestError && <p className="break-words text-xs text-destructive">{provider.lastTestError}</p>}
    </div>
  );
}

function ProviderCard({ provider, onEdit, onDelete, onActivate, onDeactivate, onTest, onConnect, connecting }) {
  const def = getEmailProviderType(provider.type);
  const Icon = def?.icon || Mail;
  const google = provider.google;
  const isOauthGoogle = provider.type === 'google' && google?.mode !== 'service_account';

  return (
    <div
      className={[
        'rounded-lg border bg-card p-4',
        provider.isActive ? 'border-emerald-500/40 ring-1 ring-emerald-500/20' : 'border-border',
      ].join(' ')}
    >
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border bg-muted/40">
          <Icon className="h-4 w-4 text-foreground" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="truncate text-sm font-semibold text-foreground">{provider.name}</p>
            <Badge tone="neutral">{provider.typeLabel}</Badge>
            {provider.isActive && (
              <Badge tone="success" dot>
                Active
              </Badge>
            )}
            {!provider.ready && provider.notReadyReason && <Badge tone="warning">Needs setup</Badge>}
          </div>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            From {provider.fromName ? `${provider.fromName} ` : ''}
            <code>&lt;{provider.effectiveFrom || provider.fromAddress || '—'}&gt;</code>
            {provider.type === 'smtp' && provider.config?.host ? ` · ${provider.config.host}:${provider.config.port}` : ''}
            {provider.type === 'microsoft' && provider.config?.sender ? ` · mailbox ${provider.config.sender}` : ''}
            {provider.type === 'mailgun' && provider.config?.domain ? ` · ${provider.config.domain}` : ''}
          </p>
          {isOauthGoogle && (
            <p className="mt-1 text-xs text-muted-foreground">
              {google?.connected ? (
                <>
                  Connected as <span className="font-medium text-foreground">{google.connectedEmail || 'Google account'}</span>
                </>
              ) : (
                <span className="text-amber-700 dark:text-amber-400">Google account not connected</span>
              )}
              {google?.usingEnvClient ? ' · using the server’s SSO_GOOGLE_* OAuth client' : ''}
            </p>
          )}
          {!provider.ready && provider.notReadyReason && !isOauthGoogle && (
            <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">{provider.notReadyReason}</p>
          )}
          <div className="mt-2">
            <TestStatus provider={provider} />
          </div>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-2 border-t border-border pt-3">
        {isOauthGoogle && (
          <Button size="sm" variant={google?.connected ? 'outline' : 'default'} onClick={() => onConnect(provider)} disabled={connecting}>
            <Link2 className="mr-1.5 h-3.5 w-3.5" />
            {connecting ? 'Redirecting…' : google?.connected ? 'Reconnect' : 'Connect Google account'}
          </Button>
        )}
        {!provider.isActive && (
          <Button size="sm" variant="outline" onClick={() => onActivate(provider)} disabled={!provider.ready}>
            <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" />
            Make active
          </Button>
        )}
        <Button size="sm" variant="outline" onClick={() => onTest(provider)} disabled={!provider.ready}>
          <Send className="mr-1.5 h-3.5 w-3.5" />
          Send test email
        </Button>
        <Button size="sm" variant="ghost" onClick={() => onEdit(provider)}>
          <Pencil className="mr-1.5 h-3.5 w-3.5" />
          Edit
        </Button>
        {provider.isActive && (
          <Button size="sm" variant="ghost" onClick={() => onDeactivate(provider)}>
            Deactivate
          </Button>
        )}
        <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => onDelete(provider)}>
          <Trash2 className="mr-1.5 h-3.5 w-3.5" />
          Delete
        </Button>
      </div>
    </div>
  );
}

/**
 * Settings → Email. Providers the org can send through; exactly one (or
 * none) is active. With none active, email falls back to the server's
 * SMTP_* settings, or is not sent at all.
 */
export default function EmailTab() {
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const [providers, setProviders] = useState([]);
  const [meta, setMeta] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [flash, setFlash] = useState(null);

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [testing, setTesting] = useState(null);
  const [confirm, setConfirm] = useState(null); // { kind, provider }
  const [connectingId, setConnectingId] = useState(null);

  const refresh = useCallback(() => {
    setLoading(true);
    return listEmailProviders()
      .then(({ providers: list, meta: m }) => {
        setProviders(list);
        setMeta(m || {});
        setError('');
      })
      .catch((err) => setError(err?.response?.data?.error?.message || err.message || 'Failed to load email providers'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Result of the Google OAuth round-trip (?connected=1 / ?error=code).
  useEffect(() => {
    const connected = searchParams.get('connected');
    const err = searchParams.get('error');
    if (!connected && !err) return;
    if (connected) setFlash({ tone: 'success', message: 'Google account connected. Send a test email, then make the provider active.' });
    else setFlash({ tone: 'danger', message: GOOGLE_ERRORS[err] || 'Could not connect the Google account.' });
    const next = new URLSearchParams(searchParams);
    next.delete('connected');
    next.delete('error');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  const active = providers.find((p) => p.isActive) || null;
  const fallbackText = meta.envSmtpConfigured
    ? "emails will use the server's SMTP_* settings"
    : 'no email will be sent (invite and reset links are shown to admins instead)';

  const runAction = async (fn, successMessage) => {
    setError('');
    try {
      await fn();
      if (successMessage) setFlash({ tone: 'success', message: successMessage });
      await refresh();
    } catch (err) {
      setError(err?.response?.data?.error?.message || err.message || 'Action failed');
    }
  };

  const handleConfirm = async () => {
    const { kind, provider } = confirm || {};
    setConfirm(null);
    if (kind === 'delete') {
      await runAction(() => deleteEmailProvider(provider.id), `Deleted ${provider.name}.`);
    } else if (kind === 'activate') {
      await runAction(() => activateEmailProvider(provider.id), `${provider.name} is now used for all outgoing email.`);
    } else if (kind === 'deactivate') {
      await runAction(() => deactivateEmailProvider(provider.id), `${provider.name} deactivated — ${fallbackText}.`);
    }
  };

  const requestActivate = (provider) => {
    if (active) setConfirm({ kind: 'activate', provider });
    else runAction(() => activateEmailProvider(provider.id), `${provider.name} is now used for all outgoing email.`);
  };

  const handleConnect = async (provider) => {
    setConnectingId(provider.id);
    setError('');
    try {
      const { authUrl } = await connectGoogleEmailProvider(provider.id);
      window.location.assign(authUrl);
    } catch (err) {
      setError(err?.response?.data?.error?.message || err.message || 'Could not start Google sign-in');
      setConnectingId(null);
    }
  };

  const confirmCopy = (() => {
    if (!confirm) return {};
    const { kind, provider } = confirm;
    if (kind === 'delete') {
      return {
        title: `Delete ${provider.name}?`,
        message: provider.isActive
          ? `This is the active provider. After deleting it no provider is active, so ${fallbackText}. Its stored credentials are removed.`
          : 'Its stored credentials are removed. This cannot be undone.',
        confirmLabel: 'Delete',
        variant: 'destructive',
      };
    }
    if (kind === 'activate') {
      return {
        title: `Switch to ${provider.name}?`,
        message: `All outgoing email will be sent through ${provider.name} (${provider.typeLabel}) instead of ${active?.name}. Only one provider can be active.`,
        confirmLabel: 'Make active',
      };
    }
    return {
      title: `Deactivate ${provider.name}?`,
      message: `With no active provider, ${fallbackText}.`,
      confirmLabel: 'Deactivate',
    };
  })();

  return (
    <SectionCard
      title="Email"
      description="How Shellius sends invitations, approval requests, sign-in codes and alerts. Add one or more providers; exactly one is used at a time."
    >
      <div className="space-y-4">
        {flash && (
          <Notice tone={flash.tone} icon={flash.tone === 'success' ? CheckCircle2 : AlertTriangle}>
            {flash.message}
          </Notice>
        )}
        {error && (
          <Notice tone="danger" icon={AlertTriangle}>
            {error}
          </Notice>
        )}

        {!loading && !active && (
          meta.envSmtpConfigured ? (
            <Notice tone="info">
              No provider is active — emails use the server&apos;s <code>SMTP_*</code> settings.
            </Notice>
          ) : (
            <Notice tone="warning" icon={AlertTriangle}>
              <strong>Emails are not being sent.</strong> No provider is active and the server has no <code>SMTP_*</code>{' '}
              settings. Add a provider and make it active.
            </Notice>
          )
        )}

        {loading ? (
          <div className="space-y-2 py-2">
            {[1, 2].map((i) => (
              <div key={i} className="h-24 animate-pulse rounded-lg bg-muted" />
            ))}
          </div>
        ) : providers.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border px-6 py-10 text-center">
            <Mail className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
            <p className="text-sm font-medium text-foreground">No email providers yet</p>
            <p className="max-w-md text-xs text-muted-foreground">
              Connect SMTP, Google, Microsoft 365, SendGrid, Mailgun, Postmark or Resend.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {providers.map((p) => (
              <ProviderCard
                key={p.id}
                provider={p}
                connecting={connectingId === p.id}
                onEdit={(prov) => {
                  setEditing(prov);
                  setFormOpen(true);
                }}
                onDelete={(prov) => setConfirm({ kind: 'delete', provider: prov })}
                onActivate={requestActivate}
                onDeactivate={(prov) => setConfirm({ kind: 'deactivate', provider: prov })}
                onTest={setTesting}
                onConnect={handleConnect}
              />
            ))}
          </div>
        )}

        <div>
          <Button
            size="sm"
            onClick={() => {
              setEditing(null);
              setFormOpen(true);
            }}
          >
            <Plus className="mr-1.5 h-4 w-4" />
            Add provider
          </Button>
        </div>
      </div>

      <EmailProviderFormModal
        open={formOpen}
        onClose={() => setFormOpen(false)}
        provider={editing}
        meta={meta}
        onSaved={(saved) => {
          setFormOpen(false);
          setFlash({ tone: 'success', message: editing ? `Saved ${saved?.name || 'provider'}.` : `Added ${saved?.name || 'provider'}.` });
          refresh();
        }}
      />

      <TestEmailModal
        open={!!testing}
        onClose={() => setTesting(null)}
        provider={testing}
        defaultTo={user?.email}
        onTested={(updated) => setProviders((list) => list.map((p) => (p.id === updated.id ? updated : p)))}
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
