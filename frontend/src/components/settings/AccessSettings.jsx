import { useState, useEffect, useCallback } from 'react';
import { ShieldCheck } from 'lucide-react';
import { SectionCard } from './shared';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { getAccessSettings, updateAccessSettings } from '@/services/orgService';
import { useAuth } from '@/context/AuthContext';
import { roleAtLeast } from '@/lib/permissions';

const OPTIONS = [
  {
    value: 'admin',
    label: 'Admins and super admins connect without approval',
    badge: 'Recommended',
    body: 'Admins and super admins get immediate access to production servers. Managers and members always need approval.',
  },
  {
    value: 'super_admin',
    label: 'Only super admins',
    body: 'Only super admins connect without approval. Admins, managers, and members always need approval on production servers.',
  },
  {
    value: 'none',
    label: 'Everyone requires approval',
    body: 'No role bypasses the approval flow — every production access request, regardless of role, needs a manager to approve it first.',
  },
];

/**
 * AccessSettings — org-wide "Production approval" policy
 * (Organization.settings.access.prodApprovalBypassMinRole). Admins can view;
 * only super_admins can change it. See docs/auth-hardening.md "Production
 * approval".
 */
function AccessSettings() {
  const { user } = useAuth();
  const canEdit = roleAtLeast(user, 'super_admin');

  const [value, setValue] = useState('admin');
  const [saved, setSaved] = useState('admin');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  const refresh = useCallback(() => {
    setLoading(true);
    setError('');
    return getAccessSettings()
      .then((data) => {
        const v = data?.prodApprovalBypassMinRole || 'admin';
        setValue(v);
        setSaved(v);
      })
      .catch((err) =>
        setError(err.response?.data?.error?.message || err.message || 'Failed to load access settings')
      )
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleSave = async () => {
    setSaving(true);
    setError('');
    setSuccess(false);
    try {
      await updateAccessSettings({ prodApprovalBypassMinRole: value });
      setSaved(value);
      setSuccess(true);
      setTimeout(() => setSuccess(false), 3000);
    } catch (err) {
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
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-16 animate-pulse rounded bg-muted" />
          ))}
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex items-start gap-3 rounded-md border border-border bg-muted/20 p-4">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            <div className="text-xs text-muted-foreground">
              <p className="font-medium text-foreground">Production approval</p>
              <p className="mt-1">
                Production servers always require approval — this isn&apos;t configurable. What you
                can control is which roles are trusted to bypass the wait: a bypass still creates an
                approved access request, is fully audited, and the server&apos;s approvers are
                notified after the fact. Managers and members always need approval on production,
                regardless of this setting.
              </p>
            </div>
          </div>

          {error && (
            <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}
          {success && (
            <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300">
              Access settings saved.
            </div>
          )}

          <fieldset className="space-y-2" disabled={!canEdit}>
            <legend className="sr-only">Production approval bypass role</legend>
            {OPTIONS.map((opt) => (
              <label
                key={opt.value}
                className={[
                  'flex cursor-pointer items-start gap-3 rounded-lg border p-4 transition-colors',
                  value === opt.value ? 'border-primary bg-primary/5' : 'border-border hover:bg-accent',
                  !canEdit && 'cursor-not-allowed opacity-70',
                ].join(' ')}
              >
                <input
                  type="radio"
                  name="prodApprovalBypassMinRole"
                  value={opt.value}
                  checked={value === opt.value}
                  onChange={(e) => setValue(e.target.value)}
                  className="mt-0.5 h-4 w-4 accent-primary"
                />
                <span>
                  <span className="flex items-center gap-2">
                    <span className="text-sm font-medium text-foreground">{opt.label}</span>
                    {opt.badge && (
                      <Badge tone="success">{opt.badge}</Badge>
                    )}
                  </span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">{opt.body}</span>
                </span>
              </label>
            ))}
          </fieldset>

          {canEdit && (
            <div className="pt-1">
              <Button type="button" onClick={handleSave} disabled={saving || value === saved}>
                {saving ? 'Saving...' : 'Save changes'}
              </Button>
            </div>
          )}
          {!canEdit && (
            <p className="text-xs text-muted-foreground">Only super admins can change this setting.</p>
          )}
        </div>
      )}
    </SectionCard>
  );
}

export default AccessSettings;
