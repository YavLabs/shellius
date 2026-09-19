import { useEffect, useState } from 'react';
import { SectionCard } from '@/components/settings/shared';
import { Button } from '@/components/ui/button';
import SearchableSelect from '@/components/ui/SearchableSelect';
import { getQuickConnectSettings, updateQuickConnectSettings } from '@/services/quickConnectService';
import { ROLE_LABELS } from '@/lib/labels';
import { Switch } from '@/components/ui/switch';

const ROLES = [
  { value: 'manager', label: ROLE_LABELS.manager },
  { value: 'admin', label: ROLE_LABELS.admin },
  { value: 'super_admin', label: ROLE_LABELS.super_admin },
];

function QuickConnectSettings() {
  const [enabled, setEnabled] = useState(true);
  const [minRole, setMinRole] = useState('manager');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    getQuickConnectSettings()
      .then((data) => {
        setEnabled(data?.enabled ?? true);
        setMinRole(data?.minRole || 'manager');
      })
      .catch((err) => setError(err.response?.data?.error?.message || err.message))
      .finally(() => setLoading(false));
  }, []);

  const handleSave = async () => {
    setSaving(true);
    setError('');
    setSaved(false);
    try {
      const data = await updateQuickConnectSettings({ enabled, minRole });
      setEnabled(data?.enabled ?? enabled);
      setMinRole(data?.minRole || minRole);
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

        <div className="flex items-center justify-between rounded-lg border border-border p-4">
          <div>
            <p className="text-sm font-medium text-foreground">Enable quick connect</p>
            <p className="text-xs text-muted-foreground">
              Allow eligible users to open ad-hoc SSH sessions to hosts that aren&apos;t saved as servers.
            </p>
          </div>
          <Switch
            checked={enabled}
            onCheckedChange={setEnabled}
          />
        </div>

        <div>
          <label className="mb-1.5 block text-sm font-medium text-foreground">Minimum role</label>
          <SearchableSelect
            className="w-64"
            value={minRole}
            onChange={setMinRole}
            options={ROLES}
            searchable={false}
            clearable={false}
            disabled={!enabled}
          />
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
