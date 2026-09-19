import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { SwitchField } from '@/components/ui/switch';
import { SectionCard } from '@/components/settings/shared';
import { getMyPreferences, updateMyPreferences } from '@/services/userPreferencesService';

/**
 * NotificationPreferencesCard — the signed-in user's own alert preferences
 * (GET/PUT /api/users/me/preferences). Lives on the Profile page so every
 * user can reach it; it used to sit in the super-admin-only Settings tab.
 */
export default function NotificationPreferencesCard() {
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

          <SwitchField
            bordered
            label="Email notifications"
            description="Receive email alerts for access request approvals, certificate expiry, and session activity."
            checked={emailEnabled}
            onCheckedChange={setEmailEnabled}
          />

          <SwitchField
            bordered
            label="Expiring soon alerts"
            description="Get notified when certificates and access requests are approaching expiry."
            checked={expiringSoonAlerts}
            onCheckedChange={setExpiringSoonAlerts}
          />

          <div className="pt-1">
            <Button onClick={handleSave} disabled={saving}>
              {saving ? 'Saving...' : 'Save preferences'}
            </Button>
          </div>
        </div>
      )}
    </SectionCard>
  );
}
