import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, Info } from 'lucide-react';
import Modal from '@/components/shared/Modal';
import { Button } from '@/components/ui/button';
import { SwitchField } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import PasswordInput from '@/components/ui/PasswordInput';
import SearchableSelect from '@/components/ui/SearchableSelect';
import { CopyButton } from '@/components/settings/shared';
import { createEmailProvider, updateEmailProvider } from '@/services/emailProviderService';
import { EMAIL_PROVIDER_TYPES, getEmailProviderType } from './providerTypes';

const inputCls =
  'h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring';
const textareaCls =
  'w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring';
const labelCls = 'mb-1.5 flex items-center gap-2 text-sm font-medium text-foreground';

function TypePicker({ onSelect }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {EMAIL_PROVIDER_TYPES.map((t) => {
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
            </span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * Add / edit an email provider. Create: type picker → form. Edit: form only
 * (the type can't change). Secret fields show "Stored — leave blank to keep".
 *
 * Props: open, onClose, provider (edit target or null), meta (list meta), onSaved(provider)
 */
export default function EmailProviderFormModal({ open, onClose, provider, meta, onSaved }) {
  const isEdit = !!provider;
  const [type, setType] = useState(null);
  const [name, setName] = useState('');
  const [fromAddress, setFromAddress] = useState('');
  const [fromName, setFromName] = useState('');
  const [values, setValues] = useState({});
  const [makeActive, setMakeActive] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError('');
    setSaving(false);
    if (provider) {
      const def = getEmailProviderType(provider.type);
      const next = {};
      for (const f of def?.fields || []) {
        const v = provider.config?.[f.key];
        next[f.key] = f.secret ? '' : v ?? def.defaults?.[f.key] ?? '';
      }
      setType(provider.type);
      setName(provider.name || '');
      setFromAddress(provider.fromAddress || '');
      setFromName(provider.fromName || '');
      setValues(next);
      setMakeActive(false);
    } else {
      setType(null);
      setName('');
      setFromAddress('');
      setFromName('Shellius');
      setValues({});
      setMakeActive(!meta?.activeProviderId);
    }
  }, [open, provider, meta?.activeProviderId]);

  const def = useMemo(() => getEmailProviderType(type), [type]);

  const pickType = (t) => {
    const d = getEmailProviderType(t);
    setType(t);
    setName(d.label);
    setValues({ ...(d.defaults || {}) });
  };

  const setValue = (key, v) => setValues((prev) => ({ ...prev, [key]: v }));
  const visibleFields = (def?.fields || []).filter((f) => !f.showIf || f.showIf(values));
  // A Google OAuth provider has no account until "Connect" — it can't be active yet.
  const canActivateNow = !(type === 'google' && values.mode !== 'service_account');

  const handleSubmit = async (e) => {
    e?.preventDefault();
    if (!def) return;
    setError('');

    const config = {};
    for (const f of visibleFields) {
      let v = values[f.key];
      if (f.secret && !v) continue; // blank secret → keep stored (edit) / unset (create)
      if (f.kind === 'number') v = v === '' || v === undefined ? undefined : Number(v);
      if (typeof v === 'string') v = v.trim();
      if (v === '' && !f.secret) v = null;
      if (v !== undefined) config[f.key] = v;
    }
    // Mode switches drop fields of the other mode from the payload only; the
    // server keeps (encrypted) whatever it already has.
    for (const f of def.fields) {
      if (f.required && visibleFields.includes(f) && !(f.secret && isEdit && provider?.config?.[f.key]?.set)) {
        const v = config[f.key];
        if (v === undefined || v === null || v === '') {
          setError(`${f.label} is required`);
          return;
        }
      }
    }
    if (def.fromRequired && !fromAddress.trim()) {
      setError(`A from address is required for ${def.label}`);
      return;
    }

    const body = {
      name: name.trim() || def.label,
      fromAddress: fromAddress.trim() || null,
      fromName: fromName.trim() || null,
      config,
    };

    setSaving(true);
    try {
      const saved = isEdit
        ? await updateEmailProvider(provider.id, body)
        : await createEmailProvider({ ...body, type, isActive: makeActive && canActivateNow });
      onSaved?.(saved);
    } catch (err) {
      setError(err?.response?.data?.error?.message || err.message || 'Failed to save provider');
    } finally {
      setSaving(false);
    }
  };

  const showPicker = !isEdit && !type;
  const title = isEdit ? `Edit ${provider?.name || 'provider'}` : showPicker ? 'Add email provider' : `Add ${def?.label}`;

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
        <Button type="submit" form="email-provider-form" size="sm" disabled={saving}>
          {saving ? 'Saving…' : isEdit ? 'Save changes' : 'Add provider'}
        </Button>
      </div>
    </div>
  );

  return (
    <Modal open={open} onClose={onClose} title={title} size="lg" footer={footer}>
      {showPicker ? (
        <TypePicker onSelect={pickType} />
      ) : (
        <form id="email-provider-form" onSubmit={handleSubmit} className="space-y-4">
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

          {type === 'google' && values.mode !== 'service_account' && meta?.googleRedirectUri && (
            <div>
              <p className={labelCls}>Authorized redirect URI</p>
              <div className="flex items-center rounded-md border border-border bg-muted/40 px-3 py-2">
                <code className="flex-1 break-all text-xs text-foreground">{meta.googleRedirectUri}</code>
                <CopyButton text={meta.googleRedirectUri} />
              </div>
              {meta.googleEnvClientConfigured && (
                <p className="mt-1 text-xs text-muted-foreground">
                  The server has SSO_GOOGLE_CLIENT_ID/SECRET set — leave the client fields blank to use them.
                </p>
              )}
            </div>
          )}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <label className={labelCls} htmlFor="ep-name">
                Name
              </label>
              <input id="ep-name" className={inputCls} value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
            </div>
            <div>
              <label className={labelCls} htmlFor="ep-from">
                From address {def?.fromRequired ? <span className="text-destructive">*</span> : null}
              </label>
              <input
                id="ep-from"
                type="email"
                className={inputCls}
                value={fromAddress}
                onChange={(e) => setFromAddress(e.target.value)}
                placeholder={def?.fromRequired ? 'noreply@example.com' : 'Defaults to the account / mailbox'}
              />
            </div>
            <div>
              <label className={labelCls} htmlFor="ep-from-name">
                From name
              </label>
              <input id="ep-from-name" className={inputCls} value={fromName} onChange={(e) => setFromName(e.target.value)} maxLength={100} />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {visibleFields.map((f) => {
              const stored = isEdit && f.secret && provider?.config?.[f.key]?.set;
              const id = `ep-${f.key}`;
              const wide = f.kind === 'textarea' || f.kind === 'select' || f.key === 'host';
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
                  ) : f.kind === 'textarea' ? (
                    <textarea
                      id={id}
                      rows={5}
                      className={textareaCls}
                      value={values[f.key] ?? ''}
                      onChange={(e) => setValue(f.key, e.target.value)}
                      placeholder={stored ? 'Stored — paste a new key to replace it' : f.placeholder || ''}
                      spellCheck={false}
                    />
                  ) : (
                    <input
                      id={id}
                      type={f.kind === 'number' ? 'number' : f.kind === 'email' ? 'email' : 'text'}
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

          {!isEdit && canActivateNow && (
            <SwitchField
              label="Use for all outgoing email"
              description={meta?.activeProviderId ? 'Replaces the currently active provider.' : undefined}
              checked={makeActive}
              onCheckedChange={setMakeActive}
            />
          )}
          {!isEdit && !canActivateNow && (
            <p className="text-xs text-muted-foreground">
              After adding it, click <strong>Connect Google account</strong>, then make it active.
            </p>
          )}
        </form>
      )}
    </Modal>
  );
}
