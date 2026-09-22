import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Info } from 'lucide-react';
import Modal from '@/components/shared/Modal';
import ConfirmDialog from '@/components/shared/ConfirmDialog';
import { Button } from '@/components/ui/button';
import { Switch, SwitchField } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import PasswordInput from '@/components/ui/PasswordInput';
import SearchableSelect from '@/components/ui/SearchableSelect';
import { createDirectorySync, updateDirectorySync } from '@/services/directorySyncService';
import {
  getAdapterType,
  valuesFromConfig,
  missingRequiredFields,
  ACTION_OPTIONS,
  actionHelp,
  SAFETY_LIMIT_FIELDS,
  isArmed,
  dryRunLabel,
} from './adapterTypes';

const inputCls =
  'h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring';
const textareaCls =
  'w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring';
const labelCls = 'mb-1.5 flex items-center gap-2 text-sm font-medium text-foreground';

const SETTINGS_DEFAULTS = {
  action: 'flag',
  dryRun: true,
  intervalHours: 24,
  maxSuspendPercent: 5,
  maxSuspendCount: 10,
  graceHours: 72,
};

/**
 * Configure directory sync for one SSO provider. There's no type picker like
 * audit sinks' — a provider's adapter (entra/okta/google/github) is fixed by
 * `entry.supportedAdapter`, so this is directly the config + settings form.
 *
 * The dry run switch gets its own visually distinct box, and turning it off
 * while Action is "Suspend automatically" — arming the feature — asks for
 * explicit confirmation naming what will happen, before the save request is
 * even sent. Editing an already-armed config doesn't re-ask on every save;
 * only the transition into armed does.
 *
 * Props: open, onClose, entry (directory-sync list entry), onSaved(sync)
 */
export default function DirectorySyncConfigModal({ open, onClose, entry, onSaved }) {
  const isEdit = !!entry?.sync;
  const def = useMemo(() => getAdapterType(entry?.supportedAdapter), [entry?.supportedAdapter]);

  const [values, setValues] = useState({});
  const [action, setAction] = useState(SETTINGS_DEFAULTS.action);
  const [dryRun, setDryRun] = useState(SETTINGS_DEFAULTS.dryRun);
  const [intervalHours, setIntervalHours] = useState(String(SETTINGS_DEFAULTS.intervalHours));
  const [maxSuspendPercent, setMaxSuspendPercent] = useState(String(SETTINGS_DEFAULTS.maxSuspendPercent));
  const [maxSuspendCount, setMaxSuspendCount] = useState(String(SETTINGS_DEFAULTS.maxSuspendCount));
  const [graceHours, setGraceHours] = useState(String(SETTINGS_DEFAULTS.graceHours));
  const [isActive, setIsActive] = useState(true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [armConfirm, setArmConfirm] = useState(null); // payload pending confirmation, or null

  useEffect(() => {
    if (!open) return;
    setError('');
    setSaving(false);
    setArmConfirm(null);
    if (entry?.sync) {
      const s = entry.sync;
      setValues(valuesFromConfig(def, s.config));
      setAction(s.action || SETTINGS_DEFAULTS.action);
      setDryRun(s.dryRun ?? SETTINGS_DEFAULTS.dryRun);
      setIntervalHours(String(s.intervalHours ?? SETTINGS_DEFAULTS.intervalHours));
      setMaxSuspendPercent(String(s.maxSuspendPercent ?? SETTINGS_DEFAULTS.maxSuspendPercent));
      setMaxSuspendCount(String(s.maxSuspendCount ?? SETTINGS_DEFAULTS.maxSuspendCount));
      setGraceHours(String(s.graceHours ?? SETTINGS_DEFAULTS.graceHours));
      setIsActive(!!s.isActive);
    } else {
      setValues(valuesFromConfig(def, {}));
      setAction(SETTINGS_DEFAULTS.action);
      setDryRun(SETTINGS_DEFAULTS.dryRun);
      setIntervalHours(String(SETTINGS_DEFAULTS.intervalHours));
      setMaxSuspendPercent(String(SETTINGS_DEFAULTS.maxSuspendPercent));
      setMaxSuspendCount(String(SETTINGS_DEFAULTS.maxSuspendCount));
      setGraceHours(String(SETTINGS_DEFAULTS.graceHours));
      setIsActive(true);
    }
  }, [open, entry, def]);

  const setValue = (key, v) => setValues((prev) => ({ ...prev, [key]: v }));

  const buildPayload = () => {
    if (!def) return { error: 'Unknown adapter' };

    const config = {};
    for (const f of def.fields) {
      const raw = values[f.key];
      if (f.secret) {
        if (!raw) continue; // blank secret -> keep stored (edit) / unset (create)
        config[f.key] = raw;
        continue;
      }
      const trimmed = typeof raw === 'string' ? raw.trim() : raw;
      if (trimmed === '' || trimmed === undefined || trimmed === null) continue;
      config[f.key] = trimmed;
    }

    const missing = missingRequiredFields(def, values, { isEdit, storedConfig: entry?.sync?.config });
    if (missing.length) return { error: `${missing[0].label} is required` };

    const nums = {
      intervalHours: Number(intervalHours),
      maxSuspendPercent: Number(maxSuspendPercent),
      maxSuspendCount: Number(maxSuspendCount),
      graceHours: Number(graceHours),
    };
    for (const [key, val] of Object.entries(nums)) {
      if (!Number.isFinite(val) || val < 0) {
        return { error: `${key} must be a non-negative number` };
      }
    }

    const settings = { action, dryRun, ...nums };
    return { config, settings };
  };

  const doSave = async (config, settings) => {
    setSaving(true);
    setError('');
    try {
      const saved = isEdit
        ? await updateDirectorySync(entry.sync.id, { config, ...settings })
        : await createDirectorySync({ ssoConfigId: entry.ssoConfigId, config, ...settings, isActive });
      onSaved?.(saved);
    } catch (err) {
      setError(err?.response?.data?.error?.message || err.message || 'Failed to save directory sync');
    } finally {
      setSaving(false);
    }
  };

  const handleSubmit = (e) => {
    e?.preventDefault();
    setError('');
    const { config, settings, error: buildError } = buildPayload();
    if (buildError) {
      setError(buildError);
      return;
    }

    const wasArmed = isEdit ? isArmed(entry.sync) : false;
    const willBeArmed = isArmed(settings);
    if (willBeArmed && !wasArmed) {
      setArmConfirm({ config, settings });
      return;
    }
    doSave(config, settings);
  };

  if (!def) return null;

  const title = isEdit ? `Configure directory sync — ${entry?.name || def.label}` : `Set up directory sync — ${entry?.name || def.label}`;

  const footer = (
    <div className="flex items-center justify-end gap-2">
      <Button type="button" variant="outline" size="sm" onClick={onClose}>
        Cancel
      </Button>
      <Button type="submit" form="directory-sync-form" size="sm" disabled={saving}>
        {saving ? 'Saving…' : isEdit ? 'Save changes' : 'Set up sync'}
      </Button>
    </div>
  );

  return (
    <Modal open={open} onClose={onClose} title={title} size="lg" footer={footer}>
      <form id="directory-sync-form" onSubmit={handleSubmit} className="space-y-5">
        {error && (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        {def.help && (
          <div className="flex gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>{def.help}</span>
          </div>
        )}

        <div>
          <p className="mb-2 text-sm font-medium text-foreground">Directory API credentials</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {def.fields.map((f) => {
              const stored = isEdit && f.secret && entry?.sync?.config?.[f.key]?.set;
              const id = `ds-${f.key}`;
              const wide = f.kind === 'textarea';
              return (
                <div key={f.key} className={wide ? 'sm:col-span-2' : ''}>
                  <label className={labelCls} htmlFor={id}>
                    {f.label}
                    {f.required && !stored ? <span className="text-destructive">*</span> : null}
                    {stored && <Badge tone="success">Stored</Badge>}
                  </label>
                  {f.kind === 'password' ? (
                    <PasswordInput
                      id={id}
                      className={inputCls}
                      value={values[f.key] ?? ''}
                      onChange={(e) => setValue(f.key, e.target.value)}
                      placeholder={stored ? 'Stored — leave blank to keep' : f.placeholder || ''}
                      autoComplete="new-password"
                    />
                  ) : f.kind === 'textarea' ? (
                    <textarea
                      id={id}
                      rows={6}
                      className={textareaCls}
                      value={values[f.key] ?? ''}
                      onChange={(e) => setValue(f.key, e.target.value)}
                      placeholder={stored ? 'Stored — paste a new value to replace it' : f.placeholder || ''}
                      spellCheck={false}
                    />
                  ) : (
                    <input
                      id={id}
                      type="text"
                      className={inputCls}
                      value={values[f.key] ?? ''}
                      onChange={(e) => setValue(f.key, e.target.value)}
                      placeholder={f.placeholder || ''}
                      autoComplete="off"
                    />
                  )}
                  {f.help && <p className="mt-1 text-xs text-muted-foreground">{f.help}</p>}
                </div>
              );
            })}
          </div>
        </div>

        <div className="space-y-3 rounded-lg border border-border p-3">
          <p className="text-sm font-medium text-foreground">What happens when it runs</p>

          <div>
            <label className={labelCls} htmlFor="ds-action">
              Action
            </label>
            <SearchableSelect
              id="ds-action"
              value={action}
              onChange={setAction}
              searchable={false}
              clearable={false}
              options={ACTION_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
            />
            <p className="mt-1 text-xs text-muted-foreground">{actionHelp(action)}</p>
          </div>

          <div>
            <label className={labelCls} htmlFor="ds-interval">
              Check every
            </label>
            <div className="flex items-center gap-2">
              <input
                id="ds-interval"
                type="number"
                min="1"
                className={`${inputCls} max-w-[8rem]`}
                value={intervalHours}
                onChange={(e) => setIntervalHours(e.target.value)}
              />
              <span className="text-sm text-muted-foreground">hours</span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">How often this check runs against the directory.</p>
          </div>
        </div>

        <div className="space-y-3 rounded-lg border border-border p-3">
          <div>
            <p className="text-sm font-medium text-foreground">Safety limits</p>
            <p className="text-xs text-muted-foreground">Protections that apply even when Action is Suspend automatically.</p>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {SAFETY_LIMIT_FIELDS.map((f) => {
              const [val, setVal] =
                f.key === 'maxSuspendPercent'
                  ? [maxSuspendPercent, setMaxSuspendPercent]
                  : f.key === 'maxSuspendCount'
                    ? [maxSuspendCount, setMaxSuspendCount]
                    : [graceHours, setGraceHours];
              return (
                <div key={f.key}>
                  <label className={labelCls} htmlFor={`ds-${f.key}`}>
                    {f.label}
                  </label>
                  <div className="flex items-center gap-2">
                    <input
                      id={`ds-${f.key}`}
                      type="number"
                      min="0"
                      className={inputCls}
                      value={val}
                      onChange={(e) => setVal(e.target.value)}
                    />
                    {f.unit && <span className="text-sm text-muted-foreground">{f.unit}</span>}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">{f.help}</p>
                </div>
              );
            })}
          </div>
        </div>

        <div
          className={`rounded-lg border-2 p-4 transition-colors ${
            dryRun
              ? 'border-blue-500/40 bg-blue-500/5'
              : action === 'suspend'
                ? 'border-amber-500/50 bg-amber-500/10'
                : 'border-border'
          }`}
        >
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
                Dry run
                {!dryRun && action === 'suspend' && <AlertTriangle className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" aria-hidden="true" />}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">{dryRunLabel({ dryRun, action })}</p>
            </div>
            <Switch checked={dryRun} onCheckedChange={setDryRun} />
          </div>
        </div>

        {!isEdit && (
          <SwitchField
            label="Enable immediately"
            description="Off keeps it saved but idle until switched on."
            checked={isActive}
            onCheckedChange={setIsActive}
          />
        )}
      </form>

      <ConfirmDialog
        open={!!armConfirm}
        title="Arm directory sync?"
        message={
          armConfirm
            ? `Dry run will be off and Action is "Suspend automatically" — the next run can suspend matching Shellius accounts for real, not just report them. It still respects the safety limits: up to ${armConfirm.settings.maxSuspendPercent}% or ${armConfirm.settings.maxSuspendCount} accounts per run, and only after a ${armConfirm.settings.graceHours}-hour grace period since first looking missing or disabled.`
            : ''
        }
        confirmLabel="Arm and save"
        variant="destructive"
        onConfirm={() => {
          const { config, settings } = armConfirm;
          setArmConfirm(null);
          doSave(config, settings);
        }}
        onCancel={() => setArmConfirm(null)}
      />
    </Modal>
  );
}
