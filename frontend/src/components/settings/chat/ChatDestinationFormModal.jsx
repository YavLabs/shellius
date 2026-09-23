import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Info } from 'lucide-react';
import Modal from '@/components/shared/Modal';
import { Button } from '@/components/ui/button';
import { SwitchField } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import PasswordInput from '@/components/ui/PasswordInput';
import SearchableSelect from '@/components/ui/SearchableSelect';
import { createChatDestination, updateChatDestination, listChatEvents } from '@/services/chatDestinationService';
import { listCustomers } from '@/services/customerService';
import {
  CHAT_VARIANTS,
  SEVERITIES,
  getVariant,
  variantFor,
  severityLabel,
  customerScopeSummary,
  CUSTOMER_SCOPE_WARNING,
  eventsSummary,
} from './chatTypes';

const inputCls =
  'h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring';
const labelCls = 'mb-1.5 flex items-center gap-2 text-sm font-medium text-foreground';

const ENVIRONMENTS = ['demo', 'dev', 'staging', 'prod'];

function TypePicker({ onSelect }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {CHAT_VARIANTS.map((v) => {
        const Icon = v.icon;
        return (
          <button
            key={v.key}
            type="button"
            onClick={() => onSelect(v.key)}
            className="group flex items-start gap-3 rounded-lg border border-border bg-card p-4 text-left transition-colors hover:border-primary/50 hover:bg-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Icon className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground group-hover:text-foreground" aria-hidden="true" />
            <span>
              <span className="flex flex-wrap items-center gap-1.5">
                <span className="block text-sm font-semibold text-foreground">{v.label}</span>
                {v.canAct && (
                  <Badge tone="accent" variant="outline">
                    Buttons + DMs
                  </Badge>
                )}
              </span>
              <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">{v.description}</span>
              <span className="mt-1 block text-xs leading-snug text-amber-700 dark:text-amber-400">{v.actionNote}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** Config → form field values (never populates a secret; "Stored" shows separately). */
function valuesFromConfig(variant, config) {
  const next = {};
  for (const f of variant?.fields || []) {
    if (f.secret) {
      next[f.key] = '';
      continue;
    }
    next[f.key] = config?.[f.key] ?? '';
  }
  return next;
}

/**
 * Add / edit a chat destination. Create: platform/mode picker → form. Edit:
 * form only (the platform and mode can't change — delete and re-add to
 * switch). Secret fields show "Stored — leave blank to keep", exactly like
 * AuditSinkFormModal / the email providers.
 *
 * Props: open, onClose, destination (edit target or null), onSaved(destination)
 */
export default function ChatDestinationFormModal({ open, onClose, destination, onSaved }) {
  const isEdit = !!destination;
  const [variantKey, setVariantKey] = useState(null);
  const [name, setName] = useState('');
  const [values, setValues] = useState({});
  const [events, setEvents] = useState([]);
  const [environments, setEnvironments] = useState([]);
  const [customerIds, setCustomerIds] = useState([]);
  const [minSeverity, setMinSeverity] = useState('');
  const [isActive, setIsActive] = useState(true);

  const [eventCatalogue, setEventCatalogue] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError('');
    setSaving(false);
    listChatEvents()
      .then(setEventCatalogue)
      .catch(() => {});
    listCustomers({ page: 1, pageSize: 200 })
      .then((r) => setCustomers(r?.items || []))
      .catch(() => setCustomers([]));

    if (destination) {
      const variant = variantFor(destination.platform, destination.mode);
      setVariantKey(variant?.key ?? null);
      setName(destination.name || '');
      setValues(valuesFromConfig(variant, destination.config));
      setEvents(destination.events || []);
      setEnvironments(destination.environments || []);
      setCustomerIds(destination.customerIds || []);
      setMinSeverity(destination.minSeverity || '');
      setIsActive(!!destination.isActive);
    } else {
      setVariantKey(null);
      setName('');
      setValues({});
      setEvents([]);
      setEnvironments([]);
      setCustomerIds([]);
      setMinSeverity('');
      setIsActive(true);
    }
  }, [open, destination]);

  const variant = useMemo(() => getVariant(variantKey), [variantKey]);

  const pickVariant = (key) => {
    const v = getVariant(key);
    setVariantKey(key);
    setName(v.label);
    setValues(valuesFromConfig(v, {}));
  };

  const setValue = (key, v) => setValues((prev) => ({ ...prev, [key]: v }));

  const eventOptions = eventCatalogue.map((e) => ({
    value: e.key,
    label: `${e.label} · ${severityLabel(e.severity)}`,
    sublabel: e.description,
  }));
  const customerOptions = customers.map((c) => ({ value: c.id, label: c.name }));
  const severityOptions = [{ value: '', label: 'Any severity' }, ...SEVERITIES.map((s) => ({ value: s, label: severityLabel(s) }))];

  const evSummary = eventsSummary(events, eventCatalogue);
  const custSummary = customerScopeSummary(customerIds);

  const handleSubmit = async (e) => {
    e?.preventDefault();
    if (!variant) return;
    setError('');

    const config = {};
    for (const f of variant.fields) {
      const raw = values[f.key];
      if (f.secret) {
        if (!raw) continue; // blank secret -> keep stored (edit) / unset (create)
        config[f.key] = String(raw).trim();
        continue;
      }
      const v = typeof raw === 'string' ? raw.trim() : raw;
      if (v) config[f.key] = v;
    }

    for (const f of variant.fields) {
      if (!f.required) continue;
      if (f.secret && isEdit && destination?.config?.[f.key]?.set) continue;
      if (!config[f.key]) {
        setError(`${f.label} is required`);
        return;
      }
    }

    const body = {
      name: name.trim() || variant.label,
      config,
      events,
      environments,
      customerIds,
      minSeverity: minSeverity || null,
    };
    if (variant.platform === 'slack') body.mode = variant.mode;

    setSaving(true);
    try {
      const saved = isEdit
        ? await updateChatDestination(destination.id, body)
        : await createChatDestination({ platform: variant.platform, isActive, ...body });
      onSaved?.(saved);
    } catch (err) {
      setError(err?.response?.data?.error?.message || err.message || 'Failed to save destination');
    } finally {
      setSaving(false);
    }
  };

  const showPicker = !isEdit && !variantKey;
  const title = isEdit ? `Edit ${destination?.name || 'destination'}` : showPicker ? 'Add chat destination' : `Add ${variant?.label}`;

  const footer = showPicker ? null : (
    <div className="flex items-center justify-between gap-2">
      <div>
        {!isEdit && (
          <Button type="button" variant="ghost" size="sm" onClick={() => setVariantKey(null)}>
            Back
          </Button>
        )}
      </div>
      <div className="flex gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" form="chat-destination-form" size="sm" disabled={saving}>
          {saving ? 'Saving…' : isEdit ? 'Save changes' : 'Add destination'}
        </Button>
      </div>
    </div>
  );

  return (
    <Modal open={open} onClose={onClose} title={title} size="lg" footer={footer}>
      {showPicker ? (
        <TypePicker onSelect={pickVariant} />
      ) : (
        <form id="chat-destination-form" onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}

          <div className="flex gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>{variant?.actionNote}</span>
          </div>

          {isEdit && destination?.target && (
            <p className="text-xs text-muted-foreground">
              Currently pointed at <span className="font-mono">{destination.target}</span>. The stored credential is never shown — replace a field below to change it.
            </p>
          )}

          <div>
            <label className={labelCls} htmlFor="cd-name">
              Name
            </label>
            <input id="cd-name" className={inputCls} value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {variant?.fields.map((f) => {
              const stored = isEdit && f.secret && destination?.config?.[f.key]?.set;
              const id = `cd-${f.key}`;
              return (
                <div key={f.key} className={f.key === 'url' || f.key === 'botToken' ? 'sm:col-span-2' : ''}>
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

          <div className="space-y-2">
            <label className={labelCls}>Events</label>
            <SearchableSelect
              multiple
              value={events}
              onChange={setEvents}
              options={eventOptions}
              placeholder="Use the defaults"
              searchable
            />
            <p className="text-xs text-muted-foreground">
              Leave empty to use the defaults — not everything, and not silence.{' '}
              {evSummary.usingDefaults ? evSummary.text : `Currently: ${evSummary.text}.`}
            </p>
          </div>

          <div>
            <label className={labelCls}>Environments</label>
            <SearchableSelect
              multiple
              value={environments}
              onChange={setEnvironments}
              options={ENVIRONMENTS.map((e) => ({ value: e, label: e }))}
              placeholder="Any environment"
              searchable={false}
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Empty = every environment. An event with no server (a directory sync, an org-wide break-glass) can never match an
              environment filter, so setting one excludes those.
            </p>
          </div>

          <div className="space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-700 dark:text-amber-400" aria-hidden="true" />
              <p className="text-xs leading-relaxed text-amber-800 dark:text-amber-300">{CUSTOMER_SCOPE_WARNING}</p>
            </div>
            <label className={labelCls}>Customers</label>
            <SearchableSelect
              multiple
              value={customerIds}
              onChange={setCustomerIds}
              options={customerOptions}
              placeholder="No customers — org-wide events only"
              searchable
            />
            <p className="text-xs font-medium text-foreground">{custSummary}</p>
          </div>

          <div>
            <label className={labelCls}>Minimum severity</label>
            <SearchableSelect
              value={minSeverity}
              onChange={setMinSeverity}
              options={severityOptions}
              searchable={false}
              clearable={false}
            />
          </div>

          {!isEdit && (
            <SwitchField
              label="Enable this destination immediately"
              description="Off keeps it saved but idle until switched on."
              checked={isActive}
              onCheckedChange={setIsActive}
            />
          )}
        </form>
      )}
    </Modal>
  );
}
