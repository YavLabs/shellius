import { useState, useEffect, useCallback } from 'react';
import {
  Copy,
  Check,
  RefreshCw,
  AlertTriangle,
  Building2,
  Shield,
  Cloud,
  Bell,
  Wifi,
  WifiOff,
} from 'lucide-react';
import ConfirmDialog from '@/components/shared/ConfirmDialog';
import { getPublicKey, getStatus, rotate } from '@/services/caService';
import { useAuth } from '@/context/AuthContext';
import { formatDateTime } from '@/utils/time';
import api from '@/services/api';

const ROLE_RANK = { super_admin: 4, admin: 3, operator: 2, viewer: 1 };
function isAtLeast(user, role) {
  return (ROLE_RANK[user?.role] || 0) >= (ROLE_RANK[role] || 0);
}

// ---------------------------------------------------------------------------
// Shared sub-components
// ---------------------------------------------------------------------------

function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text || '');
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* ignore */
    }
  };
  return (
    <button
      onClick={handleCopy}
      className="ml-2 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded border border-input bg-background text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
      title="Copy to clipboard"
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
    </button>
  );
}

function SectionCard({ title, description, children }) {
  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="border-b border-border px-5 py-4">
        <h2 className="text-base font-semibold text-foreground">{title}</h2>
        {description && (
          <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      <div className="px-5 py-4">{children}</div>
    </div>
  );
}

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

const inputCls =
  'h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-60';

// ---------------------------------------------------------------------------
// Tab 1 — Organization
// ---------------------------------------------------------------------------

function OrgTab() {
  const { user } = useAuth();
  // TODO: Load from /api/org once the backend endpoint is implemented.
  // For now, org name comes from the auth context; other fields are stubs.
  const [name, setName] = useState(user?.orgName || user?.org?.name || '');
  const [domain, setDomain] = useState('');
  const [logoUrl, setLogoUrl] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  const handleSave = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      // TODO: implement PUT /api/org — backend endpoint pending
      await new Promise((r) => setTimeout(r, 600)); // stub delay
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
      <div className="mb-4 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
        TODO: /api/org endpoint not yet implemented. Edits are not persisted.
      </div>
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
            Organization Name
          </label>
          <input
            className={inputCls}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Acme Corp"
          />
        </div>
        <div>
          <label className="mb-1.5 block text-sm font-medium text-foreground">
            Domain
          </label>
          <input
            className={inputCls}
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
          <input
            className={inputCls}
            value={logoUrl}
            onChange={(e) => setLogoUrl(e.target.value)}
            placeholder="https://cdn.example.com/logo.png"
            type="url"
          />
        </div>
        <div className="pt-1">
          <button
            type="submit"
            disabled={saving}
            className="flex h-9 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
          >
            {saving ? 'Saving...' : 'Save changes'}
          </button>
        </div>
      </form>
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------
// Tab 2 — CA Management (from phase 5D)
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
      title="Certificate Authority"
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

          <MetaRow label="Public Key">
            <div className="flex items-start gap-2">
              <pre className="flex-1 overflow-x-auto rounded border border-border bg-muted/40 px-3 py-2 font-mono text-xs text-muted-foreground whitespace-pre-wrap break-all">
                {publicKey?.publicKey || '-'}
              </pre>
              {publicKey?.publicKey && <CopyButton text={publicKey.publicKey} />}
            </div>
          </MetaRow>

          <MetaRow label="Created">{formatDateTime(status?.createdAt)}</MetaRow>
          <MetaRow label="Last Rotated">
            {status?.rotatedAt ? formatDateTime(status.rotatedAt) : 'Never'}
          </MetaRow>
          <MetaRow label="Certificates Issued">{status?.certCount ?? '-'}</MetaRow>
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
                <button
                  onClick={() => setRotateConfirm(true)}
                  disabled={rotating}
                  className="flex h-9 items-center gap-2 rounded-md bg-destructive px-4 text-sm font-medium text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50"
                >
                  <RefreshCw className="h-4 w-4" />
                  {rotating ? 'Rotating...' : 'Rotate CA'}
                </button>
              </div>
            </div>
          )}
        </dl>
      )}

      <ConfirmDialog
        open={rotateConfirm}
        title="Rotate Certificate Authority"
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
// Tab 3 — SSO
// ---------------------------------------------------------------------------

const SSO_PROVIDERS = ['oidc', 'saml'];

function SsoTab() {
  const [provider, setProvider] = useState('oidc');
  const [clientId, setClientId] = useState('');
  const [issuerUrl, setIssuerUrl] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null); // null | 'ok' | 'fail'
  const [error, setError] = useState('');

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    setError('');
    try {
      // TODO: /api/sso/test endpoint pending backend implementation
      await api.post('/sso/test', { provider, clientId, issuerUrl });
      setTestResult('ok');
    } catch (err) {
      setTestResult('fail');
      setError(err.response?.data?.error?.message || 'Connection test failed. Backend endpoint may not be implemented yet.');
    } finally {
      setTesting(false);
    }
  };

  const selectCls =
    'h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring';

  return (
    <SectionCard
      title="SSO Configuration"
      description="Configure Single Sign-On via OIDC or SAML for your organization."
    >
      <div className="mb-4 rounded-md border border-muted px-3 py-2 text-xs text-muted-foreground">
        Configure SSO — backend endpoint pending. Values entered here are not persisted
        until /api/sso is implemented.
      </div>

      <div className="space-y-4">
        {error && (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}
        {testResult === 'ok' && (
          <div className="flex items-center gap-2 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300">
            <Wifi className="h-4 w-4" />
            Connection successful.
          </div>
        )}

        <div>
          <label className="mb-1.5 block text-sm font-medium text-foreground">Provider</label>
          <select
            className={selectCls}
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
          >
            {SSO_PROVIDERS.map((p) => (
              <option key={p} value={p}>
                {p.toUpperCase()}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="mb-1.5 block text-sm font-medium text-foreground">Client ID</label>
          <input
            className={inputCls}
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            placeholder="your-client-id"
          />
        </div>

        <div>
          <label className="mb-1.5 block text-sm font-medium text-foreground">Issuer URL</label>
          <input
            className={inputCls}
            value={issuerUrl}
            onChange={(e) => setIssuerUrl(e.target.value)}
            placeholder="https://accounts.google.com"
            type="url"
          />
        </div>

        <div className="flex items-center gap-3 pt-1">
          <button
            type="button"
            disabled={testing}
            onClick={handleTest}
            className="flex h-9 items-center gap-2 rounded-md border border-input bg-background px-4 text-sm font-medium text-foreground hover:bg-accent disabled:opacity-50 transition-colors"
          >
            {testing ? (
              <WifiOff className="h-4 w-4 animate-pulse" />
            ) : (
              <Wifi className="h-4 w-4" />
            )}
            {testing ? 'Testing...' : 'Test Connection'}
          </button>
          <button
            type="button"
            disabled
            className="flex h-9 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground opacity-50 cursor-not-allowed"
          >
            Save SSO Config
          </button>
        </div>
      </div>
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------
// Tab 4 — Cloud Connectors
// ---------------------------------------------------------------------------

function CloudConnectorsTab() {
  return (
    <SectionCard
      title="Cloud Connectors"
      description="Auto-discover servers from AWS, Azure, and GCP."
    >
      <div className="rounded-lg border border-dashed border-border bg-muted/20 px-6 py-10 text-center">
        <Cloud className="mx-auto h-10 w-10 text-muted-foreground/40" />
        <p className="mt-3 text-sm font-medium text-muted-foreground">
          Coming soon (Phase 4)
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

const EMAIL_NOTIF_KEY = 'shellius:email_notifications';

function NotificationsTab() {
  const [emailEnabled, setEmailEnabled] = useState(() => {
    try {
      return localStorage.getItem(EMAIL_NOTIF_KEY) !== 'false';
    } catch {
      return true;
    }
  });

  const handleToggle = () => {
    const next = !emailEnabled;
    setEmailEnabled(next);
    try {
      localStorage.setItem(EMAIL_NOTIF_KEY, String(next));
    } catch {
      /* ignore */
    }
  };

  return (
    <SectionCard
      title="Notification Preferences"
      description="Control how you receive alerts from Shellius."
    >
      <div className="mb-4 rounded-md border border-muted px-3 py-2 text-xs text-muted-foreground">
        TODO: Persist notification preferences to user profile once /api/users/:id/preferences
        is implemented. Currently stored in localStorage only.
      </div>

      <div className="flex items-center justify-between rounded-lg border border-border p-4">
        <div>
          <p className="text-sm font-medium text-foreground">Email notifications</p>
          <p className="text-xs text-muted-foreground">
            Receive email alerts for access request approvals, certificate expiry, and
            session activity.
          </p>
        </div>
        <button
          onClick={handleToggle}
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
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------
// Tabs config
// ---------------------------------------------------------------------------

const TABS = [
  { key: 'org', label: 'Organization', icon: Building2 },
  { key: 'ca', label: 'CA Management', icon: Shield },
  { key: 'sso', label: 'SSO', icon: Wifi },
  { key: 'connectors', label: 'Cloud Connectors', icon: Cloud },
  { key: 'notifications', label: 'Notifications', icon: Bell },
];

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

function Settings() {
  const [activeTab, setActiveTab] = useState('org');

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Organization and infrastructure configuration.
        </p>
      </div>

      {/* Tab bar */}
      <div className="flex flex-wrap items-center gap-1 border-b border-border">
        {TABS.map((tab) => {
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
      {activeTab === 'org' && <OrgTab />}
      {activeTab === 'ca' && <CaTab />}
      {activeTab === 'sso' && <SsoTab />}
      {activeTab === 'connectors' && <CloudConnectorsTab />}
      {activeTab === 'notifications' && <NotificationsTab />}
    </div>
  );
}

export default Settings;
