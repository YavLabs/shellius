import { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { SectionCard } from '@/components/settings/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { getPostureSettings, updatePostureSettings } from '@/services/postureService';
import { useUnsavedChanges } from '@/components/admin/AdminFrameContext';

const DEFAULTS = {
  snapshotRetentionDays: 7,
  metricRetentionHours: 24,
  findingRetentionDays: 90,
  collectorIntervalMinutes: 5,
  expectedPublicPorts: [],
};

function NumberField({ label, description, value, onChange, min = 1, max }) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border border-border p-4">
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground">{label}</p>
        {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
      </div>
      <Input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-9 w-24 shrink-0 text-right"
      />
    </div>
  );
}

/**
 * Administration → Organization → Posture → General: retention windows, the
 * collector poll interval and the org's expected-public port list (§7 —
 * a port on this list downgrades a finding to EXPECTED_PUBLIC / INFO
 * instead of it staying a standing alert).
 */
function PostureGeneralTab() {
  const [settings, setSettings] = useState(DEFAULTS);
  const [saved, setSaved] = useState(DEFAULTS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState('');
  const [newPort, setNewPort] = useState('');
  const [newNote, setNewNote] = useState('');

  const dirty = !loading && JSON.stringify(settings) !== JSON.stringify(saved);
  useUnsavedChanges(dirty);

  useEffect(() => {
    getPostureSettings()
      .then((data) => {
        const merged = { ...DEFAULTS, ...data, expectedPublicPorts: data?.expectedPublicPorts || [] };
        setSettings(merged);
        setSaved(merged);
      })
      .catch((err) => setError(err.response?.data?.error?.message || err.message || 'Failed to load posture settings'))
      .finally(() => setLoading(false));
  }, []);

  const handleSave = async () => {
    setSaving(true);
    setError('');
    setSuccess(false);
    try {
      const data = await updatePostureSettings(settings);
      const merged = { ...DEFAULTS, ...data, expectedPublicPorts: data?.expectedPublicPorts || [] };
      setSettings(merged);
      setSaved(merged);
      setSuccess(true);
      setTimeout(() => setSuccess(false), 3000);
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message || 'Failed to save posture settings');
    } finally {
      setSaving(false);
    }
  };

  const addPort = () => {
    const port = Number(newPort);
    if (!port || port < 1 || port > 65535) return;
    if (settings.expectedPublicPorts.some((p) => p.port === port)) return;
    setSettings((s) => ({
      ...s,
      expectedPublicPorts: [...s.expectedPublicPorts, { port, note: newNote.trim() || undefined }],
    }));
    setNewPort('');
    setNewNote('');
  };

  const removePort = (port) => {
    setSettings((s) => ({ ...s, expectedPublicPorts: s.expectedPublicPorts.filter((p) => p.port !== port) }));
  };

  if (loading) {
    return (
      <SectionCard title="Posture — General" description="Retention windows, the collector interval and expected-public ports.">
        <div className="h-40 animate-pulse rounded bg-muted" />
      </SectionCard>
    );
  }

  return (
    <SectionCard
      title="Posture — General"
      description="How long posture data is kept, how often hosts report, and which public ports are expected (so they don't stay standing alerts)."
    >
      <div className="space-y-5">
        {error && (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}
        {success && (
          <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300">
            Posture settings saved.
          </div>
        )}

        <div className="space-y-3">
          <NumberField
            label="Snapshot retention"
            description="How long raw snapshot payloads are kept, in days."
            value={settings.snapshotRetentionDays}
            onChange={(v) => setSettings((s) => ({ ...s, snapshotRetentionDays: v }))}
            max={90}
          />
          <NumberField
            label="Metric sample retention"
            description="How long CPU / memory / disk / load samples are kept, in hours."
            value={settings.metricRetentionHours}
            onChange={(v) => setSettings((s) => ({ ...s, metricRetentionHours: v }))}
            max={168}
          />
          <NumberField
            label="Resolved finding retention"
            description="How long a resolved finding stays visible before it's pruned, in days."
            value={settings.findingRetentionDays}
            onChange={(v) => setSettings((s) => ({ ...s, findingRetentionDays: v }))}
            max={365}
          />
          <NumberField
            label="Collector interval"
            description="How often the collector reports, in minutes (floor 1)."
            value={settings.collectorIntervalMinutes}
            onChange={(v) => setSettings((s) => ({ ...s, collectorIntervalMinutes: v }))}
            min={1}
            max={60}
          />
        </div>

        <div className="rounded-lg border border-border p-4">
          <p className="mb-1 text-sm font-medium text-foreground">Expected-public ports</p>
          <p className="mb-3 text-xs text-muted-foreground">
            A finding on one of these ports is downgraded to Info (“Expected public”) instead of staying a standing
            alert — e.g. 22 and 443 on a bastion. The matched rule is always shown on the finding.
          </p>

          {settings.expectedPublicPorts.length > 0 && (
            <ul className="mb-3 divide-y divide-border overflow-hidden rounded-md border border-border">
              {settings.expectedPublicPorts.map((p) => (
                <li key={p.port} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                  <span className="font-mono text-foreground">{p.port}</span>
                  <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{p.note}</span>
                  <button
                    onClick={() => removePort(p.port)}
                    className="shrink-0 rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                    aria-label={`Remove port ${p.port}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              type="number"
              min={1}
              max={65535}
              value={newPort}
              onChange={(e) => setNewPort(e.target.value)}
              placeholder="Port"
              className="h-9 sm:w-24"
            />
            <Input
              value={newNote}
              onChange={(e) => setNewNote(e.target.value)}
              placeholder="Why it's expected (optional)"
              className="h-9 flex-1"
            />
            <Button variant="outline" size="sm" onClick={addPort} disabled={!newPort} className="shrink-0">
              <Plus className="mr-1.5 h-4 w-4" /> Add
            </Button>
          </div>
        </div>

        <div className="pt-1">
          <Button onClick={handleSave} disabled={saving || !dirty}>
            {saving ? 'Saving...' : 'Save changes'}
          </Button>
        </div>
      </div>
    </SectionCard>
  );
}

export default PostureGeneralTab;
