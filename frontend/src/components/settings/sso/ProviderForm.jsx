import { useEffect, useState } from 'react';
import { CheckCircle, Wifi, WifiOff, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import SearchableSelect from '@/components/ui/SearchableSelect';
import PasswordInput from '@/components/ui/PasswordInput';
import { DomainChipsInput, GithubOrgChipsInput } from './ChipsInput';
import IdpConfigPanel from './IdpConfigPanel';
import {
  createSsoProvider,
  updateSsoProvider,
  testDraftSsoProvider,
  testSavedSsoProvider,
} from '@/services/ssoConfigService';
import { SwitchField } from '@/components/ui/switch';
import { listRoles } from '@/services/roleService';

// Mirrors the shadcn <Input> default styling so PasswordInput (raw input) matches.
const SHADCN_INPUT_CLS =
  'flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50';

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

/**
 * ProviderForm — create or edit a single SSO provider. Used inside a Dialog
 * by SsoTab. `preset` (from config/ssoProviders.js) drives which fields are
 * shown; `existingProvider` (an SsoProviderDTO), when present, puts the form
 * in edit mode.
 */
export default function ProviderForm({ preset, existingProvider, orgGroups, onSaved, onCancel }) {
  const isEdit = !!existingProvider;
  const isGithub = preset.protocol === 'github';

  const [name, setName] = useState(existingProvider?.name || preset.label);
  const [formData, setFormData] = useState(() => {
    if (!existingProvider) return { scopes: preset.defaultScopes || '' };
    const initial = { scopes: existingProvider.scopes || preset.defaultScopes || '' };
    if (existingProvider.clientId) initial.clientId = existingProvider.clientId;
    if (existingProvider.issuerUrl) {
      // Derived-issuer presets (Entra/Okta/Auth0) don't re-show the raw
      // issuer as an editable field — only generic OIDC and GitHub's
      // optional Enterprise URL do.
      if (preset.id === 'generic' || isGithub) initial.issuerUrl = existingProvider.issuerUrl;
    }
    return initial;
  });
  const [hasStoredSecret, setHasStoredSecret] = useState(!!existingProvider?.hasClientSecret);
  const [isActive, setIsActive] = useState(existingProvider?.isActive ?? true);

  const [defaultRole, setDefaultRole] = useState(existingProvider?.defaultRole || 'member');
  // Roles SSO may hand out automatically: never Super admin, never a role
  // with sensitive permissions (the API refuses those too).
  const [roleOptions, setRoleOptions] = useState([
    { value: 'member', label: 'Member' },
    { value: 'manager', label: 'Manager' },
  ]);
  useEffect(() => {
    listRoles()
      .then((roles) =>
        setRoleOptions(
          roles
            .filter((r) => !r.locked && (r.sensitivePermissions || []).length === 0)
            .map((r) => ({ value: r.key, label: r.name }))
        )
      )
      .catch(() => {});
  }, []);
  const [defaultGroupId, setDefaultGroupId] = useState(existingProvider?.defaultGroupId || '');
  const [autoProvision, setAutoProvision] = useState(existingProvider?.autoProvision ?? true);
  const [allowedDomains, setAllowedDomains] = useState(existingProvider?.allowedDomains || []);
  const [allowedOrgs, setAllowedOrgs] = useState(existingProvider?.allowedOrgs || []);
  const [requireVerifiedEmail, setRequireVerifiedEmail] = useState(
    existingProvider?.requireVerifiedEmail ?? true
  );

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [savedProvider, setSavedProvider] = useState(existingProvider || null);

  const callbackUrl = savedProvider?.callbackUrl || '';

  function getEffectiveIssuerUrl() {
    if (preset.deriveIssuerUrl) return preset.deriveIssuerUrl(formData) || '';
    if (preset.issuerUrl) return preset.issuerUrl;
    return formData.issuerUrl || '';
  }

  const handleFieldChange = (field, value) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
    setTestResult(null);
  };

  function buildBody() {
    const effectiveIssuer = getEffectiveIssuerUrl();
    const body = {
      name: name.trim(),
      presetId: preset.id,
      provider: isGithub ? 'github' : 'oidc',
      clientId: (formData.clientId || '').trim(),
      isActive,
      defaultRole,
      defaultGroupId: defaultGroupId || null,
      autoProvision,
      allowedDomains,
      requireVerifiedEmail,
    };
    if (effectiveIssuer) body.issuerUrl = effectiveIssuer.trim();
    const scopes = (formData.scopes || preset.defaultScopes || '').trim();
    if (scopes) body.scopes = scopes;
    const secret = (formData.clientSecret || '').trim();
    if (secret) body.clientSecret = secret;
    if (isGithub) body.allowedOrgs = allowedOrgs;
    return body;
  }

  const canSave = (() => {
    if (!name.trim()) return false;
    if (!(formData.clientId || '').trim()) return false;
    if (!hasStoredSecret && !(formData.clientSecret || '').trim()) return false;
    if (preset.id === 'generic' && !getEffectiveIssuerUrl()) return false;
    if (preset.fields.includes('tenantId') && !(formData.tenantId || '').trim()) return false;
    if (preset.fields.includes('oktaDomain') && !(formData.oktaDomain || '').trim()) return false;
    if (preset.fields.includes('auth0Domain') && !(formData.auth0Domain || '').trim()) return false;
    return true;
  })();

  const handleSave = async () => {
    setSaving(true);
    setSaveError('');
    try {
      const body = buildBody();
      const saved = isEdit
        ? await updateSsoProvider(existingProvider.id, body)
        : await createSsoProvider(body);
      setSavedProvider(saved);
      setHasStoredSecret(true);
      setFormData((prev) => ({ ...prev, clientSecret: '' }));
      onSaved?.(saved);
    } catch (err) {
      setSaveError(err.response?.data?.error?.message || err.message || 'Failed to save provider');
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = savedProvider
        ? await testSavedSsoProvider(savedProvider.id)
        : await testDraftSsoProvider(buildBody());
      setTestResult({ ok: result?.ok !== false, ...result });
    } catch (err) {
      setTestResult({
        ok: false,
        error: err.response?.data?.error?.message || err.message || 'Connection test failed',
      });
    } finally {
      setTesting(false);
    }
  };

  const effectiveIssuerUrl = getEffectiveIssuerUrl();
  // Fields rendered generically from preset.fields — GitHub's issuerUrl is
  // handled specially below (optional Enterprise URL), not via this list.
  const genericFields = preset.fields.filter((f) => !(isGithub && f === 'issuerUrl'));

  return (
    <div className="space-y-5">
      <IdpConfigPanel preset={preset} callbackUrl={callbackUrl} />

      <div>
        <label className="mb-1.5 block text-sm font-medium text-foreground">
          Name <span className="text-destructive">*</span>
        </label>
        <Input value={name} onChange={(e) => { setName(e.target.value); setTestResult(null); }} placeholder={preset.label} />
      </div>

      {isGithub && (
        <div>
          <label className="mb-1.5 block text-sm font-medium text-foreground">
            GitHub Enterprise URL <span className="text-muted-foreground font-normal">(optional)</span>
          </label>
          <Input
            value={formData.issuerUrl || ''}
            onChange={(e) => handleFieldChange('issuerUrl', e.target.value)}
            placeholder="https://ghe.example.com"
          />
          <p className="mt-1 text-xs text-muted-foreground">
            Leave blank to use github.com. Set this to sign in with a GitHub Enterprise Server instance.
          </p>
        </div>
      )}

      {preset.id !== 'generic' && !isGithub && effectiveIssuerUrl && (
        <div>
          <label className="mb-1.5 block text-sm font-medium text-foreground">Issuer URL (computed)</label>
          <Input value={effectiveIssuerUrl} readOnly className="font-mono text-xs bg-muted/40 text-muted-foreground" />
        </div>
      )}

      {genericFields.map((field) => {
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

      {isGithub && (
        <div>
          <label className="mb-1.5 block text-sm font-medium text-foreground">Allowed GitHub organizations</label>
          <GithubOrgChipsInput orgs={allowedOrgs} onChange={setAllowedOrgs} />
        </div>
      )}

      {/* Active toggle */}
      <SwitchField
        bordered
        label="Active"
        description="Shown as a sign-in button on the login page."
        checked={isActive}
        onCheckedChange={setIsActive}
      />

      {/* Security gating */}
      <div className="rounded-md border border-border p-4 space-y-4">
        <div>
          <h4 className="text-sm font-semibold text-foreground">Security</h4>
          <p className="text-xs text-muted-foreground mt-0.5">
            Who is allowed to sign in or link an identity via this provider.
          </p>
        </div>

        <div>
          <label className="mb-1.5 block text-sm font-medium text-foreground">Allowed email domains</label>
          <DomainChipsInput domains={allowedDomains} onChange={setAllowedDomains} />
        </div>

        <SwitchField
          label="Require verified email for account linking"
          description="On (recommended): a sign-in only links to an existing password account when the identity provider confirms the email address is verified. Off: link on email match alone."
          checked={requireVerifiedEmail}
          onCheckedChange={setRequireVerifiedEmail}
        />
      </div>

      {/* Provisioning */}
      <div className="rounded-md border border-border p-4 space-y-4">
        <div>
          <h4 className="text-sm font-semibold text-foreground">New user provisioning</h4>
          <p className="text-xs text-muted-foreground mt-0.5">
            What happens when someone signs in with this provider for the first time.
          </p>
        </div>

        <SwitchField
          label="Auto-provision new users"
          description="On: any verified sign-in gets an account. Off: only invited / existing users can sign in — others are told to contact an admin."
          checked={autoProvision}
          onCheckedChange={setAutoProvision}
        />

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Default role</label>
            <SearchableSelect
              className="w-full"
              value={defaultRole}
              onChange={(v) => setDefaultRole(v)}
              searchable={false}
              clearable={false}
              options={roleOptions}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Default group (optional)</label>
            <SearchableSelect
              className="w-full"
              value={defaultGroupId}
              onChange={(v) => setDefaultGroupId(v)}
              searchable
              clearable={false}
              options={[{ value: '', label: '— None —' }, ...(orgGroups || []).map((g) => ({ value: g.id, label: g.name }))]}
            />
          </div>
        </div>
      </div>

      {saveError && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {saveError}
        </div>
      )}

      {testResult && (
        <div
          className={[
            'rounded-md border px-4 py-3',
            testResult.ok ? 'border-emerald-500/40 bg-emerald-500/10' : 'border-destructive/50 bg-destructive/10',
          ].join(' ')}
        >
          <div className="flex items-center gap-2">
            {testResult.ok ? (
              <CheckCircle className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
            ) : (
              <XCircle className="h-4 w-4 text-destructive" />
            )}
            <span className={['text-sm font-medium', testResult.ok ? 'text-emerald-700 dark:text-emerald-300' : 'text-destructive'].join(' ')}>
              {testResult.ok ? 'Connection successful' : 'Connection failed'}
            </span>
          </div>
          {testResult.message && (
            <p className={['mt-1 text-xs', testResult.ok ? 'text-emerald-700 dark:text-emerald-300' : 'text-destructive'].join(' ')}>
              {testResult.message}
            </p>
          )}
          {!testResult.ok && testResult.error && (
            <p className="mt-1 text-xs text-destructive">{testResult.error}</p>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" variant="outline" disabled={testing || !canSave} onClick={handleTest}>
            {testing ? <WifiOff className="mr-2 h-4 w-4 animate-pulse" /> : <Wifi className="mr-2 h-4 w-4" />}
            {testing ? 'Testing...' : 'Test connection'}
          </Button>
          <Button type="button" disabled={saving || !canSave} onClick={handleSave}>
            {saving ? 'Saving...' : isEdit ? 'Save changes' : 'Add provider'}
          </Button>
        </div>
        <button type="button" onClick={onCancel} className="text-sm text-muted-foreground hover:text-foreground">
          Cancel
        </button>
      </div>
    </div>
  );
}
