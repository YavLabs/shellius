import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, Info } from 'lucide-react';
import Modal from '@/components/shared/Modal';
import { Button } from '@/components/ui/button';
import { SwitchField } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import PasswordInput from '@/components/ui/PasswordInput';
import SearchableSelect from '@/components/ui/SearchableSelect';
import { createAuditSink, updateAuditSink } from '@/services/auditSinkService';
import { getAuditFacets } from '@/services/auditService';
import { formatLabel } from '@/utils/format';
import {
  SINK_TYPES,
  getSinkType,
  visibleFieldsFor,
  headersToText,
  parseHeadersInput,
  recipientsToText,
  parseRecipientsInput,
} from './sinkTypes';

const inputCls =
  'h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring';
const textareaCls =
  'w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring';
const labelCls = 'mb-1.5 flex items-center gap-2 text-sm font-medium text-foreground';

const WIDE_KINDS = new Set(['textarea', 'select', 'json', 'emails']);

function TypePicker({ onSelect }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {SINK_TYPES.map((t) => {
        const Icon = t.icon;
        return (
          <button
            key={t.type}
            type="button"
            onClick={() => onSelect(t.type)}
            className="group flex items-start gap-3 rounded-lg border border-border bg-card p-4 text-left transition-colors hover:border-primary/50 hover:bg-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Icon className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground group-hover:text-foreground" aria-hidden="true" />
            <span>
              <span className="block text-sm font-semibold text-foreground">{t.label}</span>
              <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">{t.description}</span>
              {!t.streaming && (
                <span className="mt-1 block text-xs font-medium text-amber-700 dark:text-amber-400">
                  Scheduled digest, not a live stream
                </span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** Config → form field values (never populates a secret; "Stored" shows separately). */
function valuesFromConfig(def, config) {
  const next = {};
  for (const f of def?.fields || []) {
    if (f.secret) {
      next[f.key] = '';
      continue;
    }
    const v = config?.[f.key] ?? def.defaults?.[f.key];
    if (f.kind === 'json') next[f.key] = headersToText(v || {});
    else if (f.kind === 'emails') next[f.key] = recipientsToText(v || []);
    else if (f.kind === 'switch') next[f.key] = v ?? false;
    else next[f.key] = v ?? '';
  }
  return next;
}

/**
 * Add / edit an audit sink. Create: type picker → form. Edit: form only (the
 * type can't change). Secret fields show "Stored — leave blank to keep",
 * exactly like EmailProviderFormModal.
 *
 * Props: open, onClose, sink (edit target or null), onSaved(sink)
 */
export default function AuditSinkFormModal({ open, onClose, sink, onSaved }) {
  const isEdit = !!sink;
  const [type, setType] = useState(null);
  const [name, setName] = useState('');
  const [values, setValues] = useState({});
  const [actionsFilter, setActionsFilter] = useState([]);
  const [resourceTypesFilter, setResourceTypesFilter] = useState([]);
  const [isActive, setIsActive] = useState(true);
  const [backfillFrom, setBackfillFrom] = useState('');
  const [facets, setFacets] = useState({ actions: [], resourceTypes: [] });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError('');
    setSaving(false);
    getAuditFacets()
      .then(setFacets)
      .catch(() => {});
    if (sink) {
      const def = getSinkType(sink.type);
      setType(sink.type);
      setName(sink.name || '');
      setValues(valuesFromConfig(def, sink.config));
      setActionsFilter(sink.filters?.actions || []);
      setResourceTypesFilter(sink.filters?.resourceTypes || []);
      setIsActive(!!sink.isActive);
      setBackfillFrom('');
    } else {
      setType(null);
      setName('');
      setValues({});
      setActionsFilter([]);
      setResourceTypesFilter([]);
      setIsActive(true);
      setBackfillFrom('');
    }
  }, [open, sink]);

  const def = useMemo(() => getSinkType(type), [type]);

  const pickType = (t) => {
    const d = getSinkType(t);
    setType(t);
    setName(d.label);
    setValues(valuesFromConfig(d, {}));
  };

  const setValue = (key, v) => setValues((prev) => ({ ...prev, [key]: v }));
  const visibleFields = useMemo(() => visibleFieldsFor(type, values), [type, values]);

  const actionOptions = [...facets.actions].sort().map((a) => ({ value: a, label: formatLabel(a) }));
  const resourceTypeOptions = [...facets.resourceTypes].sort().map((t) => ({ value: t, label: t }));

  const handleSubmit = async (e) => {
    e?.preventDefault();
    if (!def) return;
    setError('');

    const config = {};
    for (const f of visibleFields) {
      const raw = values[f.key];
      if (f.secret) {
        if (!raw) continue; // blank secret -> keep stored (edit) / unset (create)
        config[f.key] = f.kind === 'textarea' ? raw : String(raw).trim();
        continue;
      }
      if (f.kind === 'json') {
        const { headers, error: hErr } = parseHeadersInput(raw);
        if (hErr) {
          setError(hErr);
          return;
        }
        config[f.key] = headers;
        continue;
      }
      if (f.kind === 'emails') {
        config[f.key] = parseRecipientsInput(raw);
        continue;
      }
      if (f.kind === 'switch') {
        config[f.key] = !!raw;
        continue;
      }
      let v = raw;
      if (f.kind === 'number') v = v === '' || v === undefined ? undefined : Number(v);
      if (typeof v === 'string') v = v.trim();
      if (v === '') v = null;
      if (v !== undefined) config[f.key] = v;
    }

    for (const f of visibleFields) {
      if (!f.required) continue;
      if (f.secret && isEdit && sink?.config?.[f.key]?.set) continue;
      const v = config[f.key];
      const empty = f.kind === 'emails' ? !(Array.isArray(v) && v.length) : v === undefined || v === null || v === '';
      if (empty) {
        setError(`${f.label} is required`);
        return;
      }
    }

    const filters = { actions: actionsFilter, resourceTypes: resourceTypesFilter };

    setSaving(true);
    try {
      const saved = isEdit
        ? await updateAuditSink(sink.id, { name: name.trim() || def.label, config, filters })
        : await createAuditSink({
            name: name.trim() || def.label,
            type,
            config,
            filters,
            isActive,
            ...(def.streaming && backfillFrom ? { backfillFrom: new Date(backfillFrom).toISOString() } : {}),
          });
      onSaved?.(saved);
    } catch (err) {
      setError(err?.response?.data?.error?.message || err.message || 'Failed to save sink');
    } finally {
      setSaving(false);
    }
  };

  const showPicker = !isEdit && !type;
  const title = isEdit ? `Edit ${sink?.name || 'sink'}` : showPicker ? 'Add audit sink' : `Add ${def?.label}`;

  const footer = showPicker ? null : (
    <div className="flex items-center justify-between gap-2">
      <div>
        {!isEdit && (
          <Button type="button" variant="ghost" size="sm" onClick={() => setType(null)}>
            <ChevronLeft className="mr-1 h-4 w-4" /> Back
          </Button>
        )}
      </div>
      <div className="flex gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" form="audit-sink-form" size="sm" disabled={saving}>
          {saving ? 'Saving…' : isEdit ? 'Save changes' : 'Add sink'}
        </Button>
      </div>
    </div>
  );

  return (
    <Modal open={open} onClose={onClose} title={title} size="lg" footer={footer}>
      {showPicker ? (
        <TypePicker onSelect={pickType} />
      ) : (
        <form id="audit-sink-form" onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}

          {def?.help && (
            <div className="flex gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span>{def.help}</span>
            </div>
          )}

          <div>
            <label className={labelCls} htmlFor="as-name">
              Name
            </label>
            <input id="as-name" className={inputCls} value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {visibleFields.map((f) => {
              const stored = isEdit && f.secret && sink?.config?.[f.key]?.set;
              const id = `as-${f.key}`;
              const wide = WIDE_KINDS.has(f.kind) || f.key === 'host' || f.key === 'url';

              if (f.kind === 'switch') {
                return (
                  <div key={f.key} className="sm:col-span-2">
                    <SwitchField
                      label={f.label}
                      description={f.help}
                      checked={!!values[f.key]}
                      onCheckedChange={(v) => setValue(f.key, v)}
                      bordered
                    />
                  </div>
                );
              }

              return (
                <div key={f.key} className={wide ? 'sm:col-span-2' : ''}>
                  <label className={labelCls} htmlFor={id}>
                    {f.label}
                    {f.required && !stored ? <span className="text-destructive">*</span> : null}
                    {stored && <Badge tone="success">Stored</Badge>}
                  </label>
                  {f.kind === 'select' ? (
                    <SearchableSelect
                      value={values[f.key] ?? f.options[0].value}
                      onChange={(v) => setValue(f.key, v)}
                      searchable={false}
                      clearable={false}
                      options={f.options}
                    />
                  ) : f.kind === 'password' ? (
                    <PasswordInput
                      id={id}
                      className={inputCls}
                      value={values[f.key] ?? ''}
                      onChange={(e) => setValue(f.key, e.target.value)}
                      placeholder={stored ? 'Stored — leave blank to keep' : f.placeholder || ''}
                      autoComplete="new-password"
                    />
                  ) : f.kind === 'textarea' || f.kind === 'json' || f.kind === 'emails' ? (
                    <textarea
                      id={id}
                      rows={f.kind === 'emails' ? 3 : 5}
                      className={textareaCls}
                      value={values[f.key] ?? ''}
                      onChange={(e) => setValue(f.key, e.target.value)}
                      placeholder={stored ? 'Stored — paste a new value to replace it' : f.placeholder || ''}
                      spellCheck={false}
                    />
                  ) : (
                    <input
                      id={id}
                      type={f.kind === 'number' ? 'number' : 'text'}
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

          <div className="space-y-3 rounded-lg border border-border p-3">
            <div>
              <p className="text-sm font-medium text-foreground">Filter what this sink receives</p>
              <p className="text-xs text-muted-foreground">Leave both empty to send everything.</p>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Actions</label>
                <SearchableSelect
                  multiple
                  value={actionsFilter}
                  onChange={setActionsFilter}
                  placeholder="All actions"
                  searchable
                  options={actionOptions}
                />
              </div>
              <div>
                <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Resource types</label>
                <SearchableSelect
                  multiple
                  value={resourceTypesFilter}
                  onChange={setResourceTypesFilter}
                  placeholder="All resource types"
                  searchable
                  options={resourceTypeOptions}
                />
              </div>
            </div>
          </div>

          {!isEdit && (
            <SwitchField
              label="Enable this sink immediately"
              description="Off keeps it saved but idle until switched on."
              checked={isActive}
              onCheckedChange={setIsActive}
            />
          )}

          {!isEdit && def?.streaming && (
            <div>
              <label className={labelCls} htmlFor="as-backfill">
                Start from
              </label>
              <input
                id="as-backfill"
                type="datetime-local"
                className={inputCls}
                value={backfillFrom}
                onChange={(e) => setBackfillFrom(e.target.value)}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Leave blank to start from now — only entries created after that are sent. Set this to also ship
                existing history from that point forward, in batches over time.
              </p>
            </div>
          )}
        </form>
      )}
    </Modal>
  );
}
