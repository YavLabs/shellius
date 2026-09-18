import { useState, useEffect, useCallback } from 'react';
import {
  RefreshCw,
  AlertTriangle,
  Building2,
  Shield,
  Cloud,
  Bell,
  Wifi,
  Settings as SettingsIcon,
  HardDrive,
  ShieldCheck,
  Zap,
  Lock,
} from 'lucide-react';
import ConfirmDialog from '@/components/shared/ConfirmDialog';
import { Badge } from '@/components/ui/badge';
import QuickConnectSettings from '@/components/settings/QuickConnectSettings';
import PageHeader from '@/components/common/PageHeader';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import SearchableSelect from '@/components/ui/SearchableSelect';
import PasswordInput from '@/components/ui/PasswordInput';
import { SectionCard, CopyButton } from '@/components/settings/shared';
import SsoTab from '@/components/settings/SsoTab';
import MfaTab from '@/components/settings/MfaTab';
import AccessSettings from '@/components/settings/AccessSettings';
import { getPublicKey, getStatus, rotate } from '@/services/caService';
import { getOrg, updateOrg } from '@/services/orgService';
import { getMyPreferences, updateMyPreferences } from '@/services/userPreferencesService';
import {
  getSmtpConfig,
  saveSmtpConfig,
  deleteSmtpConfig,
  testSmtpConfig,
} from '@/services/smtpConfigService';
import {
  getStorageConfig,
  saveStorageConfig,
  deleteStorageConfig,
  testStorageConfig,
} from '@/services/storageConfigService';
import { useAuth } from '@/context/AuthContext';
import { formatDateTime } from '@/utils/time';

const ROLE_RANK = { super_admin: 4, admin: 3, manager: 2, member: 1 };
function isAtLeast(user, role) {
  return (ROLE_RANK[user?.role] || 0) >= (ROLE_RANK[role] || 0);
}

// Mirrors the shadcn <Input> default styling so PasswordInput (raw input) matches.
const SHADCN_INPUT_CLS =
  'flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50';

// SectionCard / CopyButton now live in components/settings/shared.jsx so the
// extracted SsoTab/MfaTab can use them without importing from this page.

function MetaRow({ label, children }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-border py-3 last:border-0">
      <dt className="w-40 shrink-0 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="flex-1 text-sm text-foreground break-all">{children}</dd>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab 1 — Organization
// ---------------------------------------------------------------------------

function OrgTab() {
  const { user } = useAuth();
  const [name, setName] = useState('');
  const [domain, setDomain] = useState('');
  const [logoUrl, setLogoUrl] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setLoading(true);
    getOrg()
      .then((org) => {
        if (org) {
          setName(org.name || user?.orgName || user?.org?.name || '');
          setDomain(org.domain || '');
          setLogoUrl(org.logoUrl || '');
        }
      })
      .catch(() => {
        // Fall back to auth context values
        setName(user?.orgName || user?.org?.name || '');
      })
      .finally(() => setLoading(false));
  }, [user]);

  const handleSave = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      await updateOrg({ name: name.trim(), domain: domain.trim() || undefined, logoUrl: logoUrl.trim() || undefined });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  return (
    <SectionCard
      title="Organization"
      description="General organization settings. Name and domain are shown across the platform."
    >
      {loading ? (
        <div className="space-y-3 py-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-9 animate-pulse rounded bg-muted" />
          ))}
        </div>
      ) : (
        <form onSubmit={handleSave} className="space-y-4">
          {error && (
            <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}
          {saved && (
            <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300">
              Saved successfully.
            </div>
          )}
          <div>
            <label className="mb-1.5 block text-sm font-medium text-foreground">
              Organization Name <span className="text-destructive">*</span>
            </label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Acme Corp"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium text-foreground">
              Domain
            </label>
            <Input
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              placeholder="acme.example.com"
              type="text"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Used for SSO redirect URIs and email verification.
            </p>
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium text-foreground">
              Logo URL
            </label>
            <Input
              value={logoUrl}
              onChange={(e) => setLogoUrl(e.target.value)}
              placeholder="https://cdn.example.com/logo.png"
              type="url"
            />
          </div>
          <div className="pt-1">
            <Button type="submit" disabled={saving}>
              {saving ? 'Saving...' : 'Save changes'}
            </Button>
          </div>
        </form>
      )}
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------
// Tab 2 — CA Management
// ---------------------------------------------------------------------------

function CaTab() {
  const { user } = useAuth();
  const isSuperAdmin = isAtLeast(user, 'super_admin');

  const [status, setStatus] = useState(null);
  const [publicKey, setPublicKey] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [rotateConfirm, setRotateConfirm] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [rotateError, setRotateError] = useState('');
  const [rotateSuccess, setRotateSuccess] = useState(false);

  const fetchCa = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [st, pk] = await Promise.all([getStatus(), getPublicKey()]);
      setStatus(st);
      setPublicKey(pk);
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message || 'Failed to load CA status');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchCa();
  }, [fetchCa]);

  const handleRotate = async () => {
    setRotating(true);
    setRotateError('');
    setRotateSuccess(false);
    try {
      await rotate();
      setRotateConfirm(false);
      setRotateSuccess(true);
      setTimeout(() => setRotateSuccess(false), 5000);
      await fetchCa();
    } catch (err) {
      setRotateError(
        err.response?.data?.error?.message || err.message || 'Rotation failed'
      );
      setRotateConfirm(false);
    } finally {
      setRotating(false);
    }
  };

  return (
    <SectionCard
      title="Certificate authority"
      description="SSH CA key pair used to sign short-lived certificates for this organization."
    >
      {loading ? (
        <div className="space-y-3 py-2">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-9 animate-pulse rounded bg-muted" />
          ))}
        </div>
      ) : error ? (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : (
        <dl className="space-y-0">
          <MetaRow label="Fingerprint">
            <span className="flex items-center">
              <span className="font-mono text-xs">{status?.fingerprint || '-'}</span>
              {status?.fingerprint && <CopyButton text={status.fingerprint} />}
            </span>
          </MetaRow>

          <MetaRow label="Public key">
            <div className="flex items-start gap-2">
              <pre className="flex-1 overflow-x-auto rounded border border-border bg-muted/40 px-3 py-2 font-mono text-xs text-muted-foreground whitespace-pre-wrap break-all">
                {publicKey?.publicKey || '-'}
              </pre>
              {publicKey?.publicKey && <CopyButton text={publicKey.publicKey} />}
            </div>
          </MetaRow>

          <MetaRow label="Created">{formatDateTime(status?.createdAt)}</MetaRow>
          <MetaRow label="Last rotated">
            {status?.rotatedAt ? formatDateTime(status.rotatedAt) : 'Never'}
          </MetaRow>
          <MetaRow label="Certificates issued">{status?.certCount ?? '-'}</MetaRow>
          <MetaRow label="Active">
            <span
              className={
                status?.isActive
                  ? 'text-emerald-600 dark:text-emerald-400'
                  : 'text-destructive'
              }
            >
              {status?.isActive ? 'Yes' : 'No'}
            </span>
          </MetaRow>

          {rotateSuccess && (
            <div className="mt-4 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300">
              CA rotated successfully. All hosts must fetch the new CA public key.
            </div>
          )}

          {rotateError && (
            <div className="mt-4 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {rotateError}
            </div>
          )}

          {isSuperAdmin && (
            <div className="mt-5 border-t border-border pt-4">
              <div className="flex items-start gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-3">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
                <div className="flex-1 text-sm text-amber-700 dark:text-amber-300">
                  Rotating the CA invalidates all existing certificates. New certificates must be
                  issued and every managed host must fetch the updated CA public key before SSH
                  connections will succeed.
                </div>
              </div>
              <div className="mt-4">
                <Button
                  variant="destructive"
                  onClick={() => setRotateConfirm(true)}
                  disabled={rotating}
                >
                  <RefreshCw className="mr-2 h-4 w-4" />
                  {rotating ? 'Rotating...' : 'Rotate CA'}
                </Button>
              </div>
            </div>
          )}
        </dl>
      )}

      <ConfirmDialog
        open={rotateConfirm}
        title="Rotate certificate authority"
        message="Rotating the CA will invalidate all existing certificates. New certificates must be issued and hosts must fetch the new CA public key. This cannot be undone."
        confirmLabel="Rotate CA"
        variant="destructive"
        onConfirm={handleRotate}
        onCancel={() => setRotateConfirm(false)}
      />
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------
// Tab 4 — Cloud Connectors
// ---------------------------------------------------------------------------

function CloudConnectorsTab() {
  return (
    <SectionCard
      title="Cloud connectors"
      description="Auto-discover servers from AWS, Azure, and GCP."
    >
      <div className="rounded-lg border border-dashed border-border bg-muted/20 px-6 py-10 text-center">
        <Cloud className="mx-auto h-10 w-10 text-muted-foreground/40" />
        <p className="mt-3 text-sm font-medium text-muted-foreground">
          Coming soon
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          Cloud connector management is scheduled for a future release.
        </p>
      </div>
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------
// Tab 5 — Notifications
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// SMTP card — admin-only, lives at the top of the Notifications tab.
// Mirrors the per-org / env-default precedence pattern: env defaults are
// shown with an "Environment default" badge; UI overrides win.
// ---------------------------------------------------------------------------
function SmtpCard() {
  const [config, setConfig] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [testResult, setTestResult] = useState(null);

  const [host, setHost] = useState('');
  const [port, setPort] = useState(587);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [fromAddress, setFromAddress] = useState('');
  const [useTls, setUseTls] = useState(true);

  const refresh = useCallback(() => {
    setLoading(true);
    return getSmtpConfig()
      .then((c) => {
        setConfig(c);
        setHost(c?.host || '');
        setPort(c?.port || 587);
        setUsername(c?.username || '');
        setPassword('');
        setFromAddress(c?.fromAddress || '');
        setUseTls(c?.useTls ?? true);
      })
      .catch((err) => setError(err?.response?.data?.error?.message || err.message || 'Failed to load SMTP config'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const sourceBadge = (field) => {
    const src = config?.source?.[field];
    if (src === 'env') {
      return (
        <Badge tone="info" className="ml-2">
          Environment default
        </Badge>
      );
    }
    if (src === 'db') {
      return (
        <Badge tone="success" className="ml-2">
          Overridden
        </Badge>
      );
    }
    return null;
  };

  const handleSave = async () => {
    setSaving(true);
    setError('');
    setSaved(false);
    try {
      const body = { host, port: Number(port), username, fromAddress, useTls };
      if (password) body.password = password;
      await saveSmtpConfig(body);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
      await refresh();
    } catch (err) {
      setError(err?.response?.data?.error?.message || err.message || 'Failed to save SMTP config');
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    setError('');
    try {
      const r = await testSmtpConfig();
      setTestResult({ ok: true, message: `Test email sent to ${r.sentTo}` });
    } catch (err) {
      setTestResult({
        ok: false,
        message: err?.response?.data?.error?.message || err.message || 'Test failed',
      });
    } finally {
      setTesting(false);
    }
  };

  const handleReset = async () => {
    if (!window.confirm('Delete the per-org SMTP override? Falls back to environment defaults.')) return;
    setError('');
    try {
      await deleteSmtpConfig();
      await refresh();
    } catch (err) {
      setError(err?.response?.data?.error?.message || err.message || 'Failed to delete SMTP config');
    }
  };

  return (
    <SectionCard
      title="SMTP Configuration"
      description="Outgoing email server. Environment variables act as defaults — UI overrides take precedence and require no restart."
    >
      {loading ? (
        <div className="space-y-2 py-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-10 animate-pulse rounded bg-muted" />
          ))}
        </div>
      ) : (
        <div className="space-y-4">
          {error && (
            <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}
          {saved && (
            <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300">
              SMTP configuration saved.
            </div>
          )}
          {!config?.configured && !error && (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
              No SMTP configured — emails are logged to stdout instead of sent.
              Configure here or set <code>SMTP_HOST</code> in the backend
              environment.
            </div>
          )}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 flex items-center text-xs font-medium text-muted-foreground">
                Host <span className="text-destructive">*</span> {sourceBadge('host')}
              </label>
              <Input value={host} onChange={(e) => setHost(e.target.value)} placeholder="smtp.sendgrid.net" />
            </div>
            <div>
              <label className="mb-1 flex items-center text-xs font-medium text-muted-foreground">
                Port {sourceBadge('port')}
              </label>
              <Input
                type="number"
                value={port}
                onChange={(e) => setPort(e.target.value)}
                placeholder="587"
              />
            </div>
            <div>
              <label className="mb-1 flex items-center text-xs font-medium text-muted-foreground">
                Username {sourceBadge('username')}
              </label>
              <Input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="apikey" />
            </div>
            <div>
              <label className="mb-1 flex items-center text-xs font-medium text-muted-foreground">
                Password {sourceBadge('password')}
              </label>
              <PasswordInput
                className={SHADCN_INPUT_CLS}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={config?.hasPassword ? 'Stored — leave blank to keep' : ''}
                autoComplete="new-password"
              />
            </div>
            <div className="sm:col-span-2">
              <label className="mb-1 flex items-center text-xs font-medium text-muted-foreground">
                From address {sourceBadge('fromAddress')}
              </label>
              <Input
                type="email"
                value={fromAddress}
                onChange={(e) => setFromAddress(e.target.value)}
                placeholder="noreply@shellius.example.com"
              />
            </div>
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={useTls}
              onChange={(e) => setUseTls(e.target.checked)}
              className="h-4 w-4 accent-primary"
            />
            <span className="text-foreground">Use TLS</span>
          </label>

          {testResult && (
            <div
              className={[
                'rounded-md border px-3 py-2 text-sm',
                testResult.ok
                  ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                  : 'border-destructive/50 bg-destructive/10 text-destructive',
              ].join(' ')}
            >
              {testResult.message}
            </div>
          )}

          <div className="flex flex-wrap gap-2 pt-1">
            <Button onClick={handleSave} disabled={saving || !host}>
              {saving ? 'Saving...' : 'Save'}
            </Button>
            <Button variant="outline" onClick={handleTest} disabled={testing || !config?.configured}>
              {testing ? 'Sending...' : 'Send test email'}
            </Button>
            {config?.source?.host === 'db' && (
              <Button variant="outline" onClick={handleReset}>
                Reset to env defaults
              </Button>
            )}
          </div>
        </div>
      )}
    </SectionCard>
  );
}

function NotificationsTab() {
  const [emailEnabled, setEmailEnabled] = useState(true);
  const [expiringSoonAlerts, setExpiringSoonAlerts] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setLoading(true);
    getMyPreferences()
      .then((prefs) => {
        if (prefs) {
          setEmailEnabled(prefs.emailNotifications ?? true);
          setExpiringSoonAlerts(prefs.expiringSoonAlerts ?? true);
        }
      })
      .catch(() => {
        // Silently fall back to defaults
      })
      .finally(() => setLoading(false));
  }, []);

  const handleSave = async () => {
    setSaving(true);
    setError('');
    try {
      await updateMyPreferences({
        emailNotifications: emailEnabled,
        expiringSoonAlerts,
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message || 'Failed to save preferences');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
    <SmtpCard />
    <SectionCard
      title="Notification preferences"
      description="Control how you receive alerts from Shellius."
    >
      {loading ? (
        <div className="space-y-3 py-2">
          {[1, 2].map((i) => (
            <div key={i} className="h-16 animate-pulse rounded bg-muted" />
          ))}
        </div>
      ) : (
        <div className="space-y-4">
          {error && (
            <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}
          {saved && (
            <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300">
              Preferences saved.
            </div>
          )}

          <div className="flex items-center justify-between rounded-lg border border-border p-4">
            <div>
              <p className="text-sm font-medium text-foreground">Email notifications</p>
              <p className="text-xs text-muted-foreground">
                Receive email alerts for access request approvals, certificate expiry, and
                session activity.
              </p>
            </div>
            <button
              onClick={() => setEmailEnabled((v) => !v)}
              role="switch"
              aria-checked={emailEnabled}
              className={[
                'relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-ring',
                emailEnabled ? 'bg-primary' : 'bg-muted-foreground/30',
              ].join(' ')}
            >
              <span
                className={[
                  'pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out',
                  emailEnabled ? 'translate-x-5' : 'translate-x-0',
                ].join(' ')}
              />
            </button>
          </div>

          <div className="flex items-center justify-between rounded-lg border border-border p-4">
            <div>
              <p className="text-sm font-medium text-foreground">Expiring soon alerts</p>
              <p className="text-xs text-muted-foreground">
                Get notified when certificates and access requests are approaching expiry.
              </p>
            </div>
            <button
              onClick={() => setExpiringSoonAlerts((v) => !v)}
              role="switch"
              aria-checked={expiringSoonAlerts}
              className={[
                'relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-ring',
                expiringSoonAlerts ? 'bg-primary' : 'bg-muted-foreground/30',
              ].join(' ')}
            >
              <span
                className={[
                  'pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out',
                  expiringSoonAlerts ? 'translate-x-5' : 'translate-x-0',
                ].join(' ')}
              />
            </button>
          </div>

          <div className="pt-1">
            <Button onClick={handleSave} disabled={saving}>
              {saving ? 'Saving...' : 'Save preferences'}
            </Button>
          </div>
        </div>
      )}
    </SectionCard>
    </div>
  );
}


// ---------------------------------------------------------------------------
// Tabs config
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Tab — Object Storage (super_admin only)
// ---------------------------------------------------------------------------

const STORAGE_PROVIDERS = [
  { value: 'minio', label: 'MinIO (self-hosted, S3-compatible)' },
  { value: 's3', label: 'AWS S3' },
  { value: 'azure', label: 'Azure Blob Storage' },
];

function StorageTab() {
  const [config, setConfig] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [testResult, setTestResult] = useState(null);

  const [provider, setProvider] = useState('minio');
  const [endpoint, setEndpoint] = useState('');
  const [region, setRegion] = useState('');
  const [bucket, setBucket] = useState('');
  const [accessKey, setAccessKey] = useState('');
  const [secretKey, setSecretKey] = useState('');
  const [useSsl, setUseSsl] = useState(false);
  const [forcePathStyle, setForcePathStyle] = useState(true);

  const refresh = useCallback(() => {
    setLoading(true);
    return getStorageConfig()
      .then((c) => {
        setConfig(c);
        setProvider(c?.provider || 'minio');
        setEndpoint(c?.endpoint || '');
        setRegion(c?.region || '');
        setBucket(c?.bucket || '');
        setAccessKey(c?.accessKey || '');
        setSecretKey('');
        setUseSsl(c?.useSsl ?? false);
        setForcePathStyle(c?.forcePathStyle ?? true);
      })
      .catch((err) =>
        setError(err?.response?.data?.error?.message || err.message || 'Failed to load storage config')
      )
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const isAzure = provider === 'azure';
  const isS3 = provider === 's3';

  const handleSave = async () => {
    setSaving(true);
    setError('');
    setSaved(false);
    try {
      const body = { provider, endpoint, region, bucket, accessKey, useSsl, forcePathStyle };
      if (secretKey) body.secretKey = secretKey;
      await saveStorageConfig(body);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
      await refresh();
    } catch (err) {
      setError(err?.response?.data?.error?.message || err.message || 'Failed to save storage config');
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    setError('');
    try {
      const r = await testStorageConfig();
      setTestResult({ ok: true, message: `Storage reachable — bucket "${r.bucket}" ready.` });
    } catch (err) {
      setTestResult({
        ok: false,
        message: err?.response?.data?.error?.message || err.message || 'Test failed',
      });
    } finally {
      setTesting(false);
    }
  };

  const handleReset = async () => {
    if (!window.confirm('Delete the storage override? Falls back to environment defaults.')) return;
    setError('');
    try {
      await deleteStorageConfig();
      await refresh();
    } catch (err) {
      setError(err?.response?.data?.error?.message || err.message || 'Failed to delete storage config');
    }
  };

  return (
    <SectionCard
      title="Object storage"
      description="Where session recordings and uploads are stored. Use the bundled MinIO container, or bring your own AWS S3 / Azure Blob — DB settings here override environment variables with no restart."
    >
      {loading ? (
        <div className="space-y-2 py-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-10 animate-pulse rounded bg-muted" />
          ))}
        </div>
      ) : (
        <div className="space-y-4">
          {error && (
            <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}
          {saved && (
            <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300">
              Storage configuration saved.
            </div>
          )}
          {config?.source === 'env' && (
            <div className="rounded-md border border-blue-500/40 bg-blue-500/10 px-3 py-2 text-sm text-blue-700 dark:text-blue-300">
              Currently using <strong>environment defaults</strong>. Saving here creates a database
              override.
            </div>
          )}
          {!config?.configured && (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
              Storage not configured — session recordings are disabled until you set a provider and
              credentials.
            </div>
          )}

          <div>
            <label className="mb-1 flex items-center text-xs font-medium text-muted-foreground">
              Provider <span className="text-destructive">*</span>
            </label>
            <SearchableSelect
              value={provider}
              onChange={(v) => setProvider(v)}
              searchable={false}
              clearable={false}
              options={STORAGE_PROVIDERS.map((p) => ({ value: p.value, label: p.label }))}
            />
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className={isAzure ? 'sm:col-span-2' : ''}>
              <label className="mb-1 flex items-center text-xs font-medium text-muted-foreground">
                {isAzure ? 'Blob endpoint (optional)' : 'Endpoint'}
              </label>
              <Input
                value={endpoint}
                onChange={(e) => setEndpoint(e.target.value)}
                placeholder={
                  isAzure
                    ? 'https://<account>.blob.core.windows.net (blank = default)'
                    : isS3
                      ? 'blank for AWS, or https://s3.custom.com'
                      : 'http://minio:9000'
                }
              />
            </div>
            {!isAzure && (
              <div>
                <label className="mb-1 flex items-center text-xs font-medium text-muted-foreground">
                  Region
                </label>
                <Input value={region} onChange={(e) => setRegion(e.target.value)} placeholder="us-east-1" />
              </div>
            )}
            <div>
              <label className="mb-1 flex items-center text-xs font-medium text-muted-foreground">
                {isAzure ? 'Container' : 'Bucket'}
              </label>
              <Input value={bucket} onChange={(e) => setBucket(e.target.value)} placeholder="shellius-recordings" />
            </div>
            <div>
              <label className="mb-1 flex items-center text-xs font-medium text-muted-foreground">
                {isAzure ? 'Account name' : 'Access key'}
              </label>
              <Input
                value={accessKey}
                onChange={(e) => setAccessKey(e.target.value)}
                placeholder={isAzure ? 'storageaccount' : 'AKIA... / minioadmin'}
                autoComplete="off"
              />
            </div>
            <div>
              <label className="mb-1 flex items-center text-xs font-medium text-muted-foreground">
                {isAzure ? 'Account key' : 'Secret key'}
              </label>
              <PasswordInput
                className={SHADCN_INPUT_CLS}
                value={secretKey}
                onChange={(e) => setSecretKey(e.target.value)}
                placeholder={config?.hasSecretKey ? 'Stored — leave blank to keep' : ''}
                autoComplete="new-password"
              />
            </div>
          </div>

          {!isAzure && (
            <div className="flex flex-wrap gap-5">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={useSsl}
                  onChange={(e) => setUseSsl(e.target.checked)}
                  className="h-4 w-4 accent-primary"
                />
                <span className="text-foreground">Use SSL/TLS</span>
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={forcePathStyle}
                  onChange={(e) => setForcePathStyle(e.target.checked)}
                  className="h-4 w-4 accent-primary"
                />
                <span className="text-foreground">Force path-style addressing (MinIO)</span>
              </label>
            </div>
          )}

          {testResult && (
            <div
              className={[
                'rounded-md border px-3 py-2 text-sm',
                testResult.ok
                  ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                  : 'border-destructive/50 bg-destructive/10 text-destructive',
              ].join(' ')}
            >
              {testResult.message}
            </div>
          )}

          <div className="flex flex-wrap gap-2 pt-1">
            <Button onClick={handleSave} disabled={saving || !provider}>
              {saving ? 'Saving...' : 'Save'}
            </Button>
            <Button variant="outline" onClick={handleTest} disabled={testing || !config?.configured}>
              {testing ? 'Testing...' : 'Test connection'}
            </Button>
            {config?.source === 'db' && (
              <Button variant="outline" onClick={handleReset}>
                Reset to env defaults
              </Button>
            )}
          </div>
        </div>
      )}
    </SectionCard>
  );
}

const TABS = [
  { key: 'org', label: 'Organization', icon: Building2, minRole: 'admin' },
  { key: 'ca', label: 'CA Management', icon: Shield, minRole: 'super_admin' },
  { key: 'sso', label: 'SSO', icon: Wifi, minRole: 'super_admin' },
  { key: 'access', label: 'Access', icon: Lock, minRole: 'admin' },
  { key: 'storage', label: 'Storage', icon: HardDrive, minRole: 'super_admin' },
  { key: 'mfa', label: 'MFA', icon: ShieldCheck, minRole: 'super_admin' },
  { key: 'quickconnect', label: 'Quick Connect', icon: Zap, minRole: 'admin' },
  { key: 'notifications', label: 'Notifications', icon: Bell, minRole: 'super_admin' },
];

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

function Settings() {
  const { user } = useAuth();
  const [activeTab, setActiveTab] = useState('org');
  const visibleTabs = TABS.filter((tab) => !tab.minRole || isAtLeast(user, tab.minRole));

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        icon={SettingsIcon}
        title="Settings"
        subtitle="Organization and infrastructure configuration."
      helpKey="settings" />

      {/* Tab bar */}
      <div className="flex flex-wrap items-center gap-1 border-b border-border">
        {visibleTabs.map((tab) => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={[
                'flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium transition-colors',
                activeTab === tab.key
                  ? 'border-b-2 border-primary text-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              ].join(' ')}
            >
              <Icon className="h-4 w-4" />
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Tab content */}
      {activeTab === 'org' && isAtLeast(user, 'admin') && <OrgTab />}
      {activeTab === 'ca' && isAtLeast(user, 'super_admin') && <CaTab />}
      {activeTab === 'sso' && isAtLeast(user, 'super_admin') && <SsoTab />}
      {activeTab === 'access' && isAtLeast(user, 'admin') && <AccessSettings />}
      {activeTab === 'storage' && isAtLeast(user, 'super_admin') && <StorageTab />}
      {activeTab === 'mfa' && isAtLeast(user, 'super_admin') && <MfaTab />}
      {activeTab === 'quickconnect' && isAtLeast(user, 'admin') && <QuickConnectSettings />}
      {activeTab === 'notifications' && isAtLeast(user, 'super_admin') && <NotificationsTab />}
    </div>
  );
}

export default Settings;
