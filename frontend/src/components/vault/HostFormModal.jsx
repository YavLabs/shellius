import { useEffect, useState } from 'react';
import { Clock, Lock, Building2 } from 'lucide-react';
import Modal from '@/components/shared/Modal';
import { Button } from '@/components/ui/button';
import SearchableSelect from '@/components/ui/SearchableSelect';
import ChipsInput from '@/components/settings/sso/ChipsInput';
import { listCredentials } from '@/services/keystoreService';
import { createVaultHost, updateVaultHost } from '@/services/vaultService';

const ASK_EACH_TIME = '__ask__';

const inputCls =
  'h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring';
const labelCls = 'mb-1.5 block text-sm font-medium text-foreground';

/**
 * HostFormModal — add/edit a My hosts entry (personal, private SSH target).
 * Identity picker offers the caller's own personal identities plus (when the
 * org allows it) org identities, or "Ask each time" for a one-off password/
 * key entered on connect (docs/personal-vault.md).
 */
function HostFormModal({ open, onClose, host, status, onSaved }) {
  const isEdit = !!host;
  const canUseOrgIdentities = !!status?.canUseOrgIdentities;

  const [name, setName] = useState('');
  const [hostAddr, setHostAddr] = useState('');
  const [port, setPort] = useState('22');
  const [username, setUsername] = useState('');
  const [identityValue, setIdentityValue] = useState(ASK_EACH_TIME);
  const [description, setDescription] = useState('');
  const [tags, setTags] = useState([]);

  const [personalIdentities, setPersonalIdentities] = useState([]);
  const [orgIdentities, setOrgIdentities] = useState([]);

  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(host?.name || '');
    setHostAddr(host?.host || '');
    setPort(host?.port ? String(host.port) : '22');
    setUsername(host?.username || '');
    setIdentityValue(host?.credential?.id || ASK_EACH_TIME);
    setDescription(host?.description || '');
    setTags(host?.tags || []);
    setError('');

    listCredentials({ scope: 'personal' })
      .then(setPersonalIdentities)
      .catch(() => setPersonalIdentities([]));
    if (canUseOrgIdentities) {
      listCredentials({ scope: 'org' })
        .then(setOrgIdentities)
        .catch(() => setOrgIdentities([]));
    } else {
      setOrgIdentities([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, host, canUseOrgIdentities]);

  const identityOptions = [
    { value: ASK_EACH_TIME, label: 'Ask each time', sublabel: 'Prompt for a password or key on each connect', scope: null },
    ...personalIdentities.map((c) => ({ value: c.id, label: c.name, sublabel: c.username, scope: 'personal' })),
    ...orgIdentities.map((c) => ({ value: c.id, label: c.name, sublabel: c.username, scope: 'org' })),
  ];

  const askEachTime = identityValue === ASK_EACH_TIME;

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    if (!name.trim()) return setError('Name is required');
    if (!hostAddr.trim()) return setError('Host is required');
    if (askEachTime && !username.trim()) return setError('Username is required when no identity is selected');

    const payload = {
      name: name.trim(),
      host: hostAddr.trim(),
      port: port ? Number(port) : undefined,
      username: username.trim() || undefined,
      credentialId: askEachTime ? (isEdit ? null : undefined) : identityValue,
      description: description.trim() || undefined,
      tags,
    };

    setSubmitting(true);
    try {
      const saved = isEdit ? await updateVaultHost(host.id, payload) : await createVaultHost(payload);
      onSaved?.(saved);
      onClose();
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message || 'Failed to save host');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={isEdit ? 'Edit host' : 'Add host'} size="md">
      <form onSubmit={handleSubmit} className="space-y-4">
        {error && (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        <div>
          <label className={labelCls}>
            Name <span className="text-destructive">*</span>
          </label>
          <input
            className={inputCls}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="home-lab"
            required
          />
        </div>

        <div className="grid grid-cols-3 gap-3">
          <div className="col-span-2">
            <label className={labelCls}>
              Host <span className="text-destructive">*</span>
            </label>
            <input
              className={`${inputCls} font-mono`}
              value={hostAddr}
              onChange={(e) => setHostAddr(e.target.value)}
              placeholder="10.0.0.5 or host.example.com"
              spellCheck={false}
              required
            />
          </div>
          <div>
            <label className={labelCls}>Port</label>
            <input
              className={inputCls}
              value={port}
              onChange={(e) => setPort(e.target.value)}
              placeholder="22"
              inputMode="numeric"
            />
          </div>
        </div>

        <div>
          <label className={labelCls}>
            Username{' '}
            {!askEachTime && <span className="font-normal text-muted-foreground">(optional — from identity)</span>}
          </label>
          <input
            className={inputCls}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="root"
            autoComplete="off"
            required={askEachTime}
          />
        </div>

        <div>
          <label className={labelCls}>Identity</label>
          <SearchableSelect
            value={identityValue}
            onChange={setIdentityValue}
            options={identityOptions}
            clearable={false}
            renderOption={(o) =>
              o.value === ASK_EACH_TIME ? (
                <span className="flex items-center gap-2">
                  <Clock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span>
                    <span className="block text-foreground">{o.label}</span>
                    <span className="block text-[11px] text-muted-foreground">{o.sublabel}</span>
                  </span>
                </span>
              ) : (
                <span className="flex items-center gap-2">
                  {o.scope === 'personal' ? (
                    <Lock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  ) : (
                    <Building2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  )}
                  <span>
                    <span className="block text-foreground">{o.label}</span>
                    <span className="block font-mono text-[11px] text-muted-foreground">{o.sublabel}</span>
                  </span>
                </span>
              )
            }
          />
          <p className="mt-1.5 text-[11px] text-muted-foreground">
            {canUseOrgIdentities
              ? 'Your own private identities, plus organization identities you have access to.'
              : 'Your own private identities.'}
          </p>
        </div>

        <div>
          <label className={labelCls}>Description</label>
          <textarea
            rows={2}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>

        <div>
          <label className={labelCls}>Tags</label>
          <ChipsInput values={tags} onChange={setTags} placeholder="Add tag…" />
        </div>

        <div data-sheet-footer className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={submitting}>
            {submitting ? 'Saving...' : isEdit ? 'Save changes' : 'Add host'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export default HostFormModal;
