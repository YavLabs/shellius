import { useState, useEffect } from 'react';
import { SectionCard } from './shared';
import { Button } from '@/components/ui/button';
import { getMfaConfig, saveMfaConfig } from '@/services/mfaService';
import { SwitchField } from '@/components/ui/switch';

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
        <SwitchField
          bordered
          label="Enable MFA"
          description="Allow users to set up two-factor authentication."
          checked={!!cfg.enabled}
          onCheckedChange={(v) => set('enabled', v)}
        />
        <SwitchField
          bordered
          label="Enforce MFA"
          description="Blocks access to the rest of Shellius until a user enrolls a method — they're redirected to a forced setup screen right after sign-in and every other API request is rejected until they finish."
          checked={!!cfg.enforced}
          onCheckedChange={(v) => set('enforced', v)}
          disabled={!cfg.enabled}
        />
        {cfg.enabled && cfg.enforced && (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
            Enforcement applies immediately to everyone without a factor enrolled, including existing users — they'll be
            required to set up MFA on their next request.
          </div>
        )}
        <SwitchField
          bordered
          label="Authenticator apps (TOTP)"
          description="Google Authenticator, 1Password, etc."
          checked={!!cfg.allowTotp}
          onCheckedChange={(v) => set('allowTotp', v)}
          disabled={!cfg.enabled}
        />
        <SwitchField
          bordered
          label="Email one-time codes"
          description="Email a 6-digit code at sign-in."
          checked={!!cfg.allowEmailOtp}
          onCheckedChange={(v) => set('allowEmailOtp', v)}
          disabled={!cfg.enabled}
        />
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
