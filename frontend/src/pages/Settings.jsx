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
  CheckCircle,
  XCircle,
  Settings as SettingsIcon,
  Key,
  Globe,
  FileKey,
  ChevronLeft,
  HardDrive,
  ShieldCheck,
} from 'lucide-react';
import { SSO_PROVIDERS, getProvider } from '@/config/ssoProviders';
import ConfirmDialog from '@/components/shared/ConfirmDialog';
import PageHeader from '@/components/common/PageHeader';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { getPublicKey, getStatus, rotate } from '@/services/caService';
import { getOrg, updateOrg } from '@/services/orgService';
import { getSsoConfig, getSsoEffective, saveSsoConfig, testSsoConnection } from '@/services/ssoConfigService';
import { listGroups as listOrgGroups } from '@/services/groupService';
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
import { getMfaConfig, saveMfaConfig } from '@/services/mfaService';
import { useAuth } from '@/context/AuthContext';
import { formatDateTime } from '@/utils/time';

const ROLE_RANK = { super_admin: 4, admin: 3, manager: 2, member: 1 };
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
// Tab 3 — SSO (two-step wizard)
// ---------------------------------------------------------------------------

/** Map provider id to a Lucide icon component */
function ProviderIcon({ providerId, className }) {
  const icons = {
    google: Cloud,
    entra: Building2,
    okta: Shield,
    auth0: Key,
    'generic-oidc': Globe,
    saml: FileKey,
  };
  const Icon = icons[providerId] || Globe;
  return <Icon className={className} />;
}

/** Field label display names */
const FIELD_LABELS = {
  clientId: 'Client ID',
  clientSecret: 'Client Secret',
  tenantId: 'Directory (Tenant) ID',
  oktaDomain: 'Okta Domain',
  auth0Domain: 'Auth0 Domain',
  issuerUrl: 'Issuer URL',
  scopes: 'Scopes',
  metadataUrl: 'Metadata URL',
};

/** Field placeholders */
const FIELD_PLACEHOLDERS = {
  clientId: 'your-client-id',
  clientSecret: 'your-client-secret',
  tenantId: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
  oktaDomain: 'acme.okta.com',
  auth0Domain: 'acme.auth0.com',
  issuerUrl: 'https://your-idp.example.com',
  scopes: 'openid email profile',
  metadataUrl: 'https://your-idp.example.com/saml/metadata',
};

function SsoTab() {
  // Step 1: provider picker (null = not chosen yet)
  const [selectedProvider, setSelectedProvider] = useState(null);

  // Step 2: form data (keyed by field name)
  const [formData, setFormData] = useState({});
  const [hasStoredSecret, setHasStoredSecret] = useState(false);
  const [isActive, setIsActive] = useState(true);
  const [fromEnv, setFromEnv] = useState(false); // prefilled from environment

  // New-user provisioning policy
  const [defaultRole, setDefaultRole] = useState('member');
  const [defaultGroupId, setDefaultGroupId] = useState('');
  const [autoProvision, setAutoProvision] = useState(true);
  const [orgGroups, setOrgGroups] = useState([]);

  // Loading / saving / testing state
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);

  // Derive the redirect URI for display
  const redirectUri = `${window.location.origin}/api/auth/sso/callback`;

  // On mount, load existing config + env defaults (for prefill) + groups
  useEffect(() => {
    setLoading(true);
    listOrgGroups()
      .then((res) => setOrgGroups(res?.items || res?.data?.items || res || []))
      .catch(() => setOrgGroups([]));
    getSsoEffective()
      .then((data) => {
        const cfg = data?.config || null;
        const env = data?.effective?.envDefaults || null;
        if (cfg) {
          const preset = cfg.presetId ? getProvider(cfg.presetId) : null;
          if (preset) setSelectedProvider(preset);
          const initial = {};
          if (cfg.clientId) initial.clientId = cfg.clientId;
          if (cfg.issuerUrl && (!preset || preset.id === 'generic-oidc')) {
            initial.issuerUrl = cfg.issuerUrl;
          }
          if (cfg.scopes) initial.scopes = cfg.scopes;
          setFormData(initial);
          setHasStoredSecret(!!cfg.hasSecret);
          setIsActive(cfg.isActive ?? true);
          setDefaultRole(cfg.defaultRole || 'member');
          setDefaultGroupId(cfg.defaultGroupId || '');
          setAutoProvision(cfg.autoProvision ?? true);
        } else if (env?.presetId) {
          // No saved row — prefill from environment variables.
          const preset = getProvider(env.presetId);
          if (preset) setSelectedProvider(preset);
          const initial = {};
          if (env.clientId) initial.clientId = env.clientId;
          if (env.issuerUrl && (!preset || preset.id === 'generic-oidc')) {
            initial.issuerUrl = env.issuerUrl;
          }
          setFormData(initial);
          setHasStoredSecret(!!env.hasClientSecret);
          setFromEnv(true);
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  /** Compute the effective issuer URL for the currently selected provider */
  function getEffectiveIssuerUrl() {
    if (!selectedProvider) return '';
    if (selectedProvider.deriveIssuerUrl) {
      return selectedProvider.deriveIssuerUrl(formData) || '';
    }
    if (selectedProvider.issuerUrl) {
      return selectedProvider.issuerUrl;
    }
    return formData.issuerUrl || '';
  }

  const handleProviderSelect = (provider) => {
    if (provider.disabled) return;
    setSelectedProvider(provider);
    // Pre-fill scopes from the provider default
    setFormData((prev) => ({
      ...prev,
      scopes: provider.defaultScopes || prev.scopes || '',
    }));
    setTestResult(null);
    setSaved(false);
    setSaveError('');
  };

  const handleBack = () => {
    setSelectedProvider(null);
    setTestResult(null);
    setSaved(false);
    setSaveError('');
  };

  const handleFieldChange = (field, value) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
    // Clear test result on any field change so stale results don't mislead
    setTestResult(null);
  };

  const handleTest = async () => {
    const issuerUrl = getEffectiveIssuerUrl();
    if (!issuerUrl) return;
    setTesting(true);
    setTestResult(null);
    try {
      const result = await testSsoConnection({ provider: 'oidc', issuerUrl });
      setTestResult({ ok: true, ...result });
    } catch (err) {
      setTestResult({
        ok: false,
        error:
          err.response?.data?.error?.message ||
          err.message ||
          'Connection test failed',
      });
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setSaveError('');
    setSaved(false);
    try {
      const issuerUrl = getEffectiveIssuerUrl();
      const body = {
        provider: selectedProvider.protocol === 'saml' ? 'saml' : 'oidc',
        presetId: selectedProvider.id,
        clientId: (formData.clientId || '').trim(),
        issuerUrl: issuerUrl.trim(),
        isActive,
        defaultRole,
        defaultGroupId: defaultGroupId || null,
        autoProvision,
      };
      // Scopes — use form field or provider default
      const scopes = (formData.scopes || selectedProvider.defaultScopes || '').trim();
      if (scopes) body.scopes = scopes;
      // Only send client secret if the user typed something new
      const secret = (formData.clientSecret || '').trim();
      if (secret) body.clientSecret = secret;
      await saveSsoConfig(body);
      setSaved(true);
      setHasStoredSecret(true);
      setFormData((prev) => ({ ...prev, clientSecret: '' }));
      setTimeout(() => setSaved(false), 4000);
    } catch (err) {
      setSaveError(
        err.response?.data?.error?.message ||
          err.message ||
          'Failed to save SSO configuration'
      );
    } finally {
      setSaving(false);
    }
  };

  // Validate that required visible fields are filled
  const canSave = (() => {
    if (!selectedProvider || selectedProvider.disabled) return false;
    const effectiveIssuer = getEffectiveIssuerUrl();
    if (!effectiveIssuer) return false;
    const clientId = (formData.clientId || '').trim();
    if (!clientId) return false;
    if (!hasStoredSecret && !(formData.clientSecret || '').trim()) return false;
    return true;
  })();

  const canTest = (() => {
    if (!selectedProvider || selectedProvider.disabled) return false;
    if (selectedProvider.protocol === 'saml') return false;
    return !!getEffectiveIssuerUrl();
  })();

  // ---- RENDER ----

  if (loading) {
    return (
      <SectionCard title="SSO Configuration" description="Configure Single Sign-On for your organization.">
        <div className="space-y-3 py-2">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-9 animate-pulse rounded bg-muted" />
          ))}
        </div>
      </SectionCard>
    );
  }

  // Step 1: provider picker grid
  if (!selectedProvider) {
    return (
      <SectionCard
        title="SSO Configuration"
        description="Select your identity provider to begin configuration."
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {SSO_PROVIDERS.map((provider) => (
            <button
              key={provider.id}
              type="button"
              disabled={provider.disabled}
              onClick={() => handleProviderSelect(provider)}
              className={[
                'group relative flex flex-col items-start gap-3 rounded-lg border p-4 text-left transition-colors',
                provider.disabled
                  ? 'cursor-not-allowed border-border bg-muted/30 opacity-60'
                  : 'cursor-pointer border-border bg-card hover:border-primary/50 hover:bg-accent',
              ].join(' ')}
            >
              {provider.disabled && (
                <span className="absolute right-3 top-3 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                  Coming in Phase 16
                </span>
              )}
              <ProviderIcon
                providerId={provider.id}
                className={[
                  'h-6 w-6',
                  provider.disabled
                    ? 'text-muted-foreground'
                    : 'text-foreground group-hover:text-primary',
                ].join(' ')}
              />
              <div>
                <p className="text-sm font-semibold text-foreground">{provider.label}</p>
                <p className="mt-0.5 text-xs text-muted-foreground leading-snug">
                  {provider.description}
                </p>
              </div>
            </button>
          ))}
        </div>
      </SectionCard>
    );
  }

  // Step 2: configure form
  const effectiveIssuerUrl = getEffectiveIssuerUrl();

  return (
    <SectionCard
      title={`SSO — ${selectedProvider.label}`}
      description={selectedProvider.description}
    >
      {/* Back link */}
      <button
        type="button"
        onClick={handleBack}
        className="mb-5 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        <ChevronLeft className="h-4 w-4" />
        Choose a different provider
      </button>

      <div className="flex flex-col gap-8 lg:flex-row">
        {/* Left: setup steps */}
        {selectedProvider.setupSteps && selectedProvider.setupSteps.length > 0 && (
          <div className="lg:w-72 shrink-0">
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Setup guide
            </h3>
            <ol className="space-y-4">
              {selectedProvider.setupSteps.map((step, idx) => (
                <li key={idx} className="flex gap-3">
                  <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold text-muted-foreground">
                    {idx + 1}
                  </span>
                  <div>
                    <p className="text-sm font-medium text-foreground">{step.title}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground leading-relaxed">
                      {step.body}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        )}

        {/* Right: form */}
        <div className="min-w-0 flex-1 space-y-4">
          {/* Redirect URI (read-only, copyable) */}
          <div>
            <label className="mb-1.5 block text-sm font-medium text-foreground">
              Redirect URI
            </label>
            <div className="flex items-center gap-2">
              <Input
                value={redirectUri}
                readOnly
                className="font-mono text-xs bg-muted/40"
              />
              <CopyButton text={redirectUri} />
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Paste this URI into your identity provider's allowed redirect URIs list.
            </p>
          </div>

          {/* Effective Issuer URL preview (read-only for non-generic-oidc) */}
          {selectedProvider.id !== 'generic-oidc' && effectiveIssuerUrl && (
            <div>
              <label className="mb-1.5 block text-sm font-medium text-foreground">
                Issuer URL (computed)
              </label>
              <Input
                value={effectiveIssuerUrl}
                readOnly
                className="font-mono text-xs bg-muted/40 text-muted-foreground"
              />
            </div>
          )}

          {/* Dynamic form fields from provider.fields */}
          {selectedProvider.fields.map((field) => {
            const isSecret = field === 'clientSecret';
            const label = FIELD_LABELS[field] || field;
            const placeholder = isSecret && hasStoredSecret
              ? 'Stored — leave blank to keep'
              : (FIELD_PLACEHOLDERS[field] || '');

            return (
              <div key={field}>
                <label className="mb-1.5 block text-sm font-medium text-foreground">
                  {label} <span className="text-destructive">*</span>
                </label>
                <Input
                  value={formData[field] || ''}
                  onChange={(e) => handleFieldChange(field, e.target.value)}
                  type={isSecret ? 'password' : 'text'}
                  autoComplete={isSecret ? 'new-password' : undefined}
                  placeholder={placeholder}
                  className={isSecret ? 'font-mono' : undefined}
                />
              </div>
            );
          })}

          {/* SSO Active toggle */}
          <div className="flex items-center gap-2 pt-1">
            <button
              role="switch"
              aria-checked={isActive}
              type="button"
              onClick={() => setIsActive((v) => !v)}
              className={[
                'relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-ring',
                isActive ? 'bg-primary' : 'bg-muted-foreground/30',
              ].join(' ')}
            >
              <span
                className={[
                  'pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out',
                  isActive ? 'translate-x-5' : 'translate-x-0',
                ].join(' ')}
              />
            </button>
            <span className="text-sm text-foreground">SSO Active</span>
          </div>

          {fromEnv && (
            <div className="rounded-md border border-blue-500/40 bg-blue-500/10 px-3 py-2 text-xs text-blue-700 dark:text-blue-300">
              Prefilled from environment variables. Save to manage provisioning options below;
              the client secret stays in the environment.
            </div>
          )}

          {/* New-user provisioning */}
          <div className="rounded-md border border-border p-4 space-y-4">
            <div>
              <h4 className="text-sm font-semibold text-foreground">New user provisioning</h4>
              <p className="text-xs text-muted-foreground mt-0.5">
                What happens when someone signs in with SSO for the first time.
              </p>
            </div>

            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={autoProvision}
                onChange={(e) => setAutoProvision(e.target.checked)}
                className="mt-0.5 h-4 w-4 accent-primary"
              />
              <span>
                <span className="text-sm font-medium text-foreground">Auto-provision new users</span>
                <span className="block text-xs text-muted-foreground">
                  On: any verified SSO email gets an account. Off: only invited / existing users can
                  sign in — others are told to contact an admin.
                </span>
              </span>
            </label>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">Default role</label>
                <select
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                  value={defaultRole}
                  onChange={(e) => setDefaultRole(e.target.value)}
                >
                  <option value="member">Member</option>
                  <option value="manager">Manager</option>
                  <option value="admin">Admin</option>
                </select>
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">Default group (optional)</label>
                <select
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                  value={defaultGroupId}
                  onChange={(e) => setDefaultGroupId(e.target.value)}
                >
                  <option value="">— None —</option>
                  {orgGroups.map((g) => (
                    <option key={g.id} value={g.id}>{g.name}</option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          {/* Feedback banners */}
          {saveError && (
            <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {saveError}
            </div>
          )}
          {saved && (
            <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300">
              SSO configuration saved.
            </div>
          )}

          {/* Test result */}
          {testResult && (
            <div
              className={[
                'rounded-md border px-4 py-3',
                testResult.ok
                  ? 'border-emerald-500/40 bg-emerald-500/10'
                  : 'border-destructive/50 bg-destructive/10',
              ].join(' ')}
            >
              <div className="flex items-center gap-2">
                {testResult.ok ? (
                  <CheckCircle className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                ) : (
                  <XCircle className="h-4 w-4 text-destructive" />
                )}
                <span
                  className={[
                    'text-sm font-medium',
                    testResult.ok
                      ? 'text-emerald-700 dark:text-emerald-300'
                      : 'text-destructive',
                  ].join(' ')}
                >
                  {testResult.ok ? 'Connection successful' : 'Connection failed'}
                </span>
              </div>
              {testResult.ok && testResult.providerName && (
                <div className="mt-2 space-y-1 text-xs text-emerald-700 dark:text-emerald-300">
                  <p>Provider: {testResult.providerName}</p>
                  {testResult.authorizationEndpoint && (
                    <p className="truncate">Auth endpoint: {testResult.authorizationEndpoint}</p>
                  )}
                  {testResult.scopesSupported && testResult.scopesSupported.length > 0 && (
                    <p>Scopes: {testResult.scopesSupported.slice(0, 8).join(', ')}</p>
                  )}
                </div>
              )}
              {!testResult.ok && testResult.error && (
                <p className="mt-1 text-xs text-destructive">{testResult.error}</p>
              )}
            </div>
          )}

          {/* Action buttons */}
          <div className="flex flex-wrap items-center gap-3 pt-1">
            <Button
              type="button"
              variant="outline"
              disabled={testing || !canTest}
              onClick={handleTest}
            >
              {testing ? (
                <WifiOff className="mr-2 h-4 w-4 animate-pulse" />
              ) : (
                <Wifi className="mr-2 h-4 w-4" />
              )}
              {testing ? 'Testing...' : 'Test Connection'}
            </Button>
            <Button
              type="button"
              disabled={saving || !canSave}
              onClick={handleSave}
            >
              {saving ? 'Saving...' : 'Save Configuration'}
            </Button>
          </div>
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
        <span className="ml-2 inline-flex items-center rounded-full bg-blue-500/15 px-2 py-0.5 text-[10px] font-medium text-blue-700 dark:text-blue-400">
          Environment default
        </span>
      );
    }
    if (src === 'db') {
      return (
        <span className="ml-2 inline-flex items-center rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-400">
          Overridden
        </span>
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
              <Input
                type="password"
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
      title="Notification Preferences"
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
      title="Object Storage"
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
            <Select value={provider} onValueChange={setProvider}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STORAGE_PROVIDERS.map((p) => (
                  <SelectItem key={p.value} value={p.value}>
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
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
              <Input
                type="password"
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

// ---------------------------------------------------------------------------
// Tab — MFA policy (super_admin only)
// ---------------------------------------------------------------------------

function MfaTab() {
  const [cfg, setCfg] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    getMfaConfig()
      .then(setCfg)
      .catch((e) => setError(e?.response?.data?.error?.message || e.message))
      .finally(() => setLoading(false));
  }, []);

  const set = (k, v) => setCfg((p) => ({ ...p, [k]: v }));

  const save = async () => {
    setSaving(true);
    setError('');
    setSaved(false);
    try {
      const next = await saveMfaConfig({
        enabled: !!cfg.enabled,
        enforced: !!cfg.enforced,
        allowTotp: cfg.allowTotp !== false,
        allowEmailOtp: cfg.allowEmailOtp !== false,
      });
      setCfg(next);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (e) {
      setError(e?.response?.data?.error?.message || e.message);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <SectionCard title="Two-factor authentication">
        <div className="h-10 animate-pulse rounded bg-muted" />
      </SectionCard>
    );
  }

  const Toggle = ({ label, desc, k, disabled }) => (
    <label className={`flex items-start gap-3 ${disabled ? 'opacity-50' : 'cursor-pointer'}`}>
      <input
        type="checkbox"
        checked={!!cfg[k]}
        disabled={disabled}
        onChange={(e) => set(k, e.target.checked)}
        className="mt-0.5 h-4 w-4 accent-primary"
      />
      <span>
        <span className="text-sm font-medium text-foreground">{label}</span>
        <span className="block text-xs text-muted-foreground">{desc}</span>
      </span>
    </label>
  );

  return (
    <SectionCard
      title="Two-factor authentication"
      description="Require a second factor at sign-in. Source: env defaults unless overridden here."
    >
      <div className="space-y-4">
        {error && (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}
        {saved && (
          <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300">
            MFA policy saved.
          </div>
        )}
        <Toggle label="Enable MFA" desc="Allow users to set up two-factor authentication." k="enabled" />
        <Toggle
          label="Enforce MFA"
          desc="Require every user to enroll before they can use the app."
          k="enforced"
          disabled={!cfg.enabled}
        />
        <Toggle label="Authenticator apps (TOTP)" desc="Google Authenticator, 1Password, etc." k="allowTotp" disabled={!cfg.enabled} />
        <Toggle label="Email one-time codes" desc="Email a 6-digit code at sign-in." k="allowEmailOtp" disabled={!cfg.enabled} />
        <div className="pt-1">
          <Button onClick={save} disabled={saving}>
            {saving ? 'Saving...' : 'Save'}
          </Button>
        </div>
      </div>
    </SectionCard>
  );
}

const TABS = [
  { key: 'org', label: 'Organization', icon: Building2, minRole: 'admin' },
  { key: 'ca', label: 'CA Management', icon: Shield, minRole: 'super_admin' },
  { key: 'sso', label: 'SSO', icon: Wifi, minRole: 'super_admin' },
  { key: 'storage', label: 'Storage', icon: HardDrive, minRole: 'super_admin' },
  { key: 'mfa', label: 'MFA', icon: ShieldCheck, minRole: 'super_admin' },
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
      {activeTab === 'storage' && isAtLeast(user, 'super_admin') && <StorageTab />}
      {activeTab === 'mfa' && isAtLeast(user, 'super_admin') && <MfaTab />}
      {activeTab === 'notifications' && isAtLeast(user, 'super_admin') && <NotificationsTab />}
    </div>
  );
}

export default Settings;
