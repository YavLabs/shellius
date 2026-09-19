import { useEffect, useState } from 'react';
import { SectionCard } from '@/components/settings/shared';
import { Button } from '@/components/ui/button';
import { getQuickConnectSettings, updateQuickConnectSettings } from '@/services/quickConnectService';
import { SwitchField } from '@/components/ui/switch';
import RolesWithPermission from '@/components/roles/RolesWithPermission';
import { useUnsavedChanges } from '@/components/admin/AdminFrameContext';

/**
 * QuickConnectSettings — the org-wide on/off switch. Who may use it is the
 * role permission "Use Quick Connect" (and "Quick Connect with stored
 * identities"), edited on the Roles page.
 */
function QuickConnectSettings() {
  const [enabled, setEnabled] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [savedEnabled, setSavedEnabled] = useState(true);

  useUnsavedChanges(!loading && enabled !== savedEnabled);

  useEffect(() => {
    getQuickConnectSettings()
      .then((data) => {
        setEnabled(data?.enabled ?? true);
        setSavedEnabled(data?.enabled ?? true);
      })
      .catch((err) => setError(err.response?.data?.error?.message || err.message))
      .finally(() => setLoading(false));
  }, []);

  const handleSave = async () => {
    setSaving(true);
    setError('');
    setSaved(false);
    try {
      const data = await updateQuickConnectSettings({ enabled });
      setEnabled(data?.enabled ?? enabled);
      setSavedEnabled(data?.enabled ?? enabled);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <SectionCard title="Quick Connect" description="Ad-hoc SSH connections without saving a server first.">
        <div className="h-10 animate-pulse rounded bg-muted" />
      </SectionCard>
    );
  }

  return (
    <SectionCard
      title="Quick Connect"
      description="Ad-hoc SSH connections without saving a server first. Credentials are used once and never stored server-side."
    >
      <div className="space-y-4">
        {error && (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}
        {saved && (
          <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300">
            Quick Connect settings saved.
          </div>
        )}

        <SwitchField
          bordered
          label="Enable quick connect"
          description="Allow eligible users to open ad-hoc SSH sessions to hosts that aren't saved as servers."
          checked={enabled}
          onCheckedChange={setEnabled}
        />

        <div className="rounded-lg border border-border p-4">
          <p className="mb-2 text-sm font-medium text-foreground">Who can use it</p>
          <p className="mb-2 text-xs text-muted-foreground">
            Roles with the “Use Quick Connect” permission. Change it under Administration → Roles.
          </p>
          <RolesWithPermission permission="quick_connect.use" emptyText="No role can use Quick Connect." />
        </div>

        <div className="pt-1">
          <Button onClick={handleSave} disabled={saving}>
            {saving ? 'Saving...' : 'Save changes'}
          </Button>
        </div>
      </div>
    </SectionCard>
  );
}

export default QuickConnectSettings;
