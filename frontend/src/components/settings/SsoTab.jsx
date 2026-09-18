import { useState, useEffect } from 'react';
import {
  Building2,
  Shield,
  Cloud,
  Key,
  Globe,
  FileKey,
  ChevronLeft,
  Wifi,
  WifiOff,
  CheckCircle,
  XCircle,
  X,
} from 'lucide-react';
import { SectionCard, CopyButton } from './shared';
import { SSO_PROVIDERS, getProvider } from '@/config/ssoProviders';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import SearchableSelect from '@/components/ui/SearchableSelect';
import PasswordInput from '@/components/ui/PasswordInput';
import { getSsoEffective, saveSsoConfig, testSsoConnection } from '@/services/ssoConfigService';
import { listGroups as listOrgGroups } from '@/services/groupService';

// Mirrors the shadcn <Input> default styling so PasswordInput (raw input) matches.
const SHADCN_INPUT_CLS =
  'flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50';

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

const DOMAIN_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;

/**
 * DomainChipsInput — type a domain and press Enter/comma to add it as a
 * removable chip. Used for the "Allowed email domains" SSO gate.
 */
function DomainChipsInput({ domains, onChange }) {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');

  const addDomain = (raw) => {
    const value = raw.trim().toLowerCase().replace(/^@/, '');
    if (!value) return;
    if (!DOMAIN_RE.test(value)) {
      setError(`"${value}" doesn't look like a valid domain.`);
      return;
    }
    if (domains.includes(value)) {
      setDraft('');
      return;
    }
    setError('');
    onChange([...domains, value]);
    setDraft('');
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addDomain(draft);
    } else if (e.key === 'Backspace' && !draft && domains.length > 0) {
      onChange(domains.slice(0, -1));
    }
  };

  return (
    <div>
      <div className="flex min-h-9 flex-wrap items-center gap-1.5 rounded-md border border-input bg-background px-2 py-1.5">
        {domains.map((d) => (
          <span
            key={d}
            className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-foreground"
          >
            {d}
            <button
              type="button"
              onClick={() => onChange(domains.filter((x) => x !== d))}
              className="rounded-full text-muted-foreground hover:text-foreground"
              aria-label={`Remove ${d}`}
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
        <input
          value={draft}
          onChange={(e) => { setDraft(e.target.value); setError(''); }}
          onKeyDown={handleKeyDown}
          onBlur={() => draft && addDomain(draft)}
          placeholder={domains.length === 0 ? 'acme.com (blank = any domain)' : 'Add domain…'}
          className="min-w-[10ch] flex-1 border-0 bg-transparent px-1 py-0.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
        />
      </div>
      {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
      <p className="mt-1 text-xs text-muted-foreground">
        Only these email domains may sign in or be provisioned via SSO. Leave empty to allow any domain.
      </p>
    </div>
  );
}

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

  // Security gating (auth hardening)
  const [allowedDomains, setAllowedDomains] = useState([]);
  const [requireVerifiedEmail, setRequireVerifiedEmail] = useState(true);

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
          setAllowedDomains(Array.isArray(cfg.allowedDomains) ? cfg.allowedDomains : []);
          setRequireVerifiedEmail(cfg.requireVerifiedEmail ?? true);
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
          const envDomains = env.allowedDomains;
          if (Array.isArray(envDomains)) setAllowedDomains(envDomains);
          else if (typeof envDomains === 'string' && envDomains.trim()) {
            setAllowedDomains(envDomains.split(',').map((d) => d.trim()).filter(Boolean));
          }
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
        allowedDomains,
        requireVerifiedEmail,
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
                {isSecret ? (
                  <PasswordInput
                    value={formData[field] || ''}
                    onChange={(e) => handleFieldChange(field, e.target.value)}
                    autoComplete="new-password"
                    placeholder={placeholder}
                    className={`${SHADCN_INPUT_CLS} font-mono`}
                  />
                ) : (
                  <Input
                    value={formData[field] || ''}
                    onChange={(e) => handleFieldChange(field, e.target.value)}
                    type="text"
                    placeholder={placeholder}
                  />
                )}
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

          {/* Security gating */}
          <div className="rounded-md border border-border p-4 space-y-4">
            <div>
              <h4 className="text-sm font-semibold text-foreground">Security</h4>
              <p className="text-xs text-muted-foreground mt-0.5">
                Who is allowed to sign in or link an identity via this provider.
              </p>
            </div>

            <div>
              <label className="mb-1.5 block text-sm font-medium text-foreground">
                Allowed email domains
              </label>
              <DomainChipsInput domains={allowedDomains} onChange={setAllowedDomains} />
            </div>

            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={requireVerifiedEmail}
                onChange={(e) => setRequireVerifiedEmail(e.target.checked)}
                className="mt-0.5 h-4 w-4 accent-primary"
              />
              <span>
                <span className="text-sm font-medium text-foreground">
                  Require verified email for account linking
                </span>
                <span className="block text-xs text-muted-foreground">
                  On (recommended): an SSO sign-in only links to an existing password account when
                  the identity provider confirms the email address is verified. Off: link on email
                  match alone — only disable this if you trust every provider to never let users
                  self-verify an email they don&apos;t own.
                </span>
              </span>
            </label>
          </div>

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
                <SearchableSelect
                  className="w-full"
                  value={defaultRole}
                  onChange={(v) => setDefaultRole(v)}
                  searchable={false}
                  clearable={false}
                  options={[
                    { value: 'member', label: 'Member' },
                    { value: 'manager', label: 'Manager' },
                    { value: 'admin', label: 'Admin' },
                  ]}
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">Default group (optional)</label>
                <SearchableSelect
                  className="w-full"
                  value={defaultGroupId}
                  onChange={(v) => setDefaultGroupId(v)}
                  searchable={true}
                  clearable={false}
                  options={[
                    { value: '', label: '— None —' },
                    ...orgGroups.map((g) => ({ value: g.id, label: g.name })),
                  ]}
                />
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

export default SsoTab;
