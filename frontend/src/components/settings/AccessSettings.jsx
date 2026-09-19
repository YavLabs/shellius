import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { ShieldCheck, Lock } from 'lucide-react';
import { SectionCard } from './shared';
import { SwitchField } from '@/components/ui/switch';
import RolesWithPermission from '@/components/roles/RolesWithPermission';
import { getAccessSettings, updateAccessSettings } from '@/services/orgService';
import { useAuth } from '@/context/AuthContext';

/**
 * AccessSettings — who may skip production approval.
 *
 * That is the role permission "Production without approval"
 * (access.prod_bypass), edited on the Roles page. This tab shows which roles
 * hold it and owns the org-wide switch: turn it off and nobody skips
 * approval, not even super admins. Needs org.access_settings.
 */
function AccessSettings() {
  const { can } = useAuth();
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const refresh = useCallback(() => {
    setLoading(true);
    setError('');
    return getAccessSettings()
      .then(setSettings)
      .catch((err) =>
        setError(err.response?.data?.error?.message || err.message || 'Failed to load access settings')
      )
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const toggle = async (next) => {
    setSaving(true);
    setError('');
    const previous = settings;
    setSettings((s) => ({ ...s, prodBypassEnabled: next }));
    try {
      setSettings(await updateAccessSettings({ prodBypassEnabled: next }));
    } catch (err) {
      setSettings(previous);
      setError(err.response?.data?.error?.message || err.message || 'Failed to save access settings');
    } finally {
      setSaving(false);
    }
  };

  const togglePersonalVault = async (next) => {
    setSaving(true);
    setError('');
    const previous = settings;
    setSettings((s) => ({ ...s, personalVaultEnabled: next }));
    try {
      setSettings(await updateAccessSettings({ personalVaultEnabled: next }));
    } catch (err) {
      setSettings(previous);
      setError(err.response?.data?.error?.message || err.message || 'Failed to save access settings');
    } finally {
      setSaving(false);
    }
  };

  return (
    <SectionCard
      title="Access"
      description="Organization-wide rules for how production access requests are handled."
    >
      {loading ? (
        <div className="space-y-3 py-2">
          {[1, 2].map((i) => (
            <div key={i} className="h-16 animate-pulse rounded bg-muted" />
          ))}
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex items-start gap-3 rounded-md border border-border bg-muted/20 p-4">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            <p className="text-xs text-muted-foreground">
              Production servers require an approved access request. Roles with the{' '}
              <span className="font-medium text-foreground">Production without approval</span> permission skip the
              wait — the request is still created with a reason, audited, and the server&apos;s approvers are
              notified afterwards.
            </p>
          </div>

          {error && (
            <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}

          <SwitchField
            bordered
            label="Allow skipping production approval"
            description={
              settings?.prodBypassEnabled
                ? 'On: roles with “Production without approval” connect to production immediately.'
                : 'Off: every production request needs an approver — including super admins. Break-glass to production is also blocked.'
            }
            checked={!!settings?.prodBypassEnabled}
            disabled={saving}
            onCheckedChange={toggle}
          />

          <div className="rounded-lg border border-border p-4">
            <div className="mb-2 flex items-center justify-between gap-2">
              <p className="text-sm font-medium text-foreground">Roles with “Production without approval”</p>
              {can('roles.view') && (
                <Link to="/roles" className="text-xs font-medium text-primary hover:underline">
                  Manage roles
                </Link>
              )}
            </div>
            <RolesWithPermission
              permission="access.prod_bypass"
              roles={settings?.rolesWithBypass || []}
              emptyText="No role can skip production approval."
            />
            {!settings?.prodBypassEnabled && (settings?.rolesWithBypass || []).length > 0 && (
              <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">
                Not in effect while the switch above is off.
              </p>
            )}
          </div>

          <SwitchField
            bordered
            label={
              <span className="flex items-center gap-1.5">
                <Lock className="h-3.5 w-3.5 text-muted-foreground" /> Personal vault
              </span>
            }
            description={
              settings?.personalVaultEnabled
                ? 'On: users may keep private identities, keys and My hosts — visible only to their owner, never to admins.'
                : 'Off: personal identities, keys and My hosts are hidden and unusable for everyone. Nothing is deleted — turning this back on restores access to what was already saved.'
            }
            checked={!!settings?.personalVaultEnabled}
            disabled={saving}
            onCheckedChange={togglePersonalVault}
          />
        </div>
      )}
    </SectionCard>
  );
}

export default AccessSettings;
