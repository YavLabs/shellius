import { useState, useEffect } from 'react';
import { SectionCard } from './shared';
import { Button } from '@/components/ui/button';
import { getMfaConfig, saveMfaConfig } from '@/services/mfaService';

/**
 * MfaTab — org-wide MFA policy (super_admin only). "Enforced" is a hard
 * gate post auth-hardening: every other API route 403s with
 * MFA_SETUP_REQUIRED for an unenrolled user until they finish /mfa-setup.
 */
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
          desc="Blocks access to the rest of Shellius until a user enrolls a method — they're redirected to a forced setup screen right after sign-in and every other API request is rejected until they finish."
          k="enforced"
          disabled={!cfg.enabled}
        />
        {cfg.enabled && cfg.enforced && (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
            Enforcement applies immediately to everyone without a factor enrolled, including
            existing users — they'll be required to set up MFA on their next request.
          </div>
        )}
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

export default MfaTab;
