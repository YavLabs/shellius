import { useEffect, useState } from 'react';
import { Lock, KeyRound } from 'lucide-react';
import Modal from '@/components/shared/Modal';
import { Button } from '@/components/ui/button';
import { SwitchField } from '@/components/ui/switch';
import PasswordInput from '@/components/ui/PasswordInput';
import SearchableSelect from '@/components/ui/SearchableSelect';
import PrivateKeyInput from './PrivateKeyInput';
import { createCredential, updateCredential, listKeys } from '@/services/keystoreService';

const KEY_TYPES = [
  { value: 'ed25519', label: 'ED25519 (recommended)' },
  { value: 'rsa', label: 'RSA' },
  { value: 'ecdsa', label: 'ECDSA' },
];

const inputCls =
  'h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring';
const labelCls = 'mb-1.5 block text-sm font-medium text-foreground';

function ToggleCard({ active, icon: Icon, title, description, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`flex flex-1 items-start gap-3 rounded-md border p-3 text-left transition-colors ${
        active ? 'border-primary bg-primary/5' : 'border-border hover:bg-accent/50'
      }`}
    >
      <span
        className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border ${
          active ? 'border-primary bg-primary text-primary-foreground' : 'border-input'
        }`}
        aria-hidden="true"
      >
        {active && <span className="h-2 w-2 rounded-sm bg-current" />}
      </span>
      <span>
        <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
          <Icon className="h-4 w-4" /> {title}
        </span>
        <span className="mt-0.5 block text-xs text-muted-foreground">{description}</span>
      </span>
    </button>
  );
}

/**
 * IdentityFormModal — create/edit a Keystore Identity (Credential).
 *
 * Props:
 *   open, onClose, identity (edit target, or null for create), onSaved
 */
function IdentityFormModal({ open, onClose, identity, onSaved, scope = 'org' }) {
  const isEdit = !!identity;

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [username, setUsername] = useState('');

  const [usePassword, setUsePassword] = useState(true);
  const [useKey, setUseKey] = useState(false);
  const [password, setPassword] = useState('');
  const [clearPassword, setClearPassword] = useState(false);

  // key selection: 'existing' | 'new' | 'generate'
  const [keyMode, setKeyMode] = useState('existing');
  const [sshKeyId, setSshKeyId] = useState('');
  const [keys, setKeys] = useState([]);
  const [privateKey, setPrivateKey] = useState('');
  const [keyPassphrase, setKeyPassphrase] = useState('');
  const [genKeyType, setGenKeyType] = useState('ed25519');
  const [genBits, setGenBits] = useState('');

  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(identity?.name || '');
    setDescription(identity?.description || '');
    setUsername(identity?.username || '');
    const authType = identity?.authType || 'password';
    setUsePassword(authType === 'password' || authType === 'key_password');
    setUseKey(authType === 'key' || authType === 'key_password');
    setPassword('');
    setClearPassword(false);
    setKeyMode('existing');
    setSshKeyId(identity?.sshKey?.id || '');
    setPrivateKey('');
    setKeyPassphrase('');
    setGenKeyType('ed25519');
    setGenBits('');
    setError('');
    listKeys({ scope })
      .then(setKeys)
      .catch(() => setKeys([]));
  }, [open, identity, scope]);

  const authType = usePassword && useKey ? 'key_password' : useKey ? 'key' : 'password';

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');

    if (!name.trim()) return setError('Name is required');
    if (!username.trim()) return setError('Username is required');
    if (!usePassword && !useKey) return setError('Choose password, private key, or both');
    if (useKey) {
      if (keyMode === 'existing' && !sshKeyId) return setError('Select a key');
      if (keyMode === 'new' && !privateKey.trim()) return setError('Paste, drop, or upload a private key');
    }

    const payload = {
      name: name.trim(),
      description: description.trim() || undefined,
      username: username.trim(),
      authType,
      // Scope is fixed at creation — PATCH never changes it (see "Move to
      // organization" for the one-way, audited path).
      ...(isEdit ? {} : { scope }),
    };

    if (usePassword) {
      if (password) payload.password = password;
      else if (isEdit && clearPassword) payload.clearPassword = true;
      // else: omitted -> keep existing on edit
    } else if (isEdit) {
      payload.clearPassword = true;
    }

    if (useKey) {
      if (keyMode === 'existing') {
        payload.sshKeyId = sshKeyId;
      } else if (keyMode === 'new') {
        payload.newKey = { privateKey: privateKey.trim(), passphrase: keyPassphrase || undefined };
      } else if (keyMode === 'generate') {
        payload.newKey = {
          generate: true,
          keyType: genKeyType,
          bits: genBits ? Number(genBits) : undefined,
        };
      }
    } else {
      payload.sshKeyId = null;
    }

    setSubmitting(true);
    try {
      const saved = isEdit
        ? await updateCredential(identity.id, payload)
        : await createCredential(payload);
      onSaved?.(saved);
      onClose();
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message || 'Failed to save identity');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isEdit ? 'Edit Identity' : scope === 'personal' ? 'New personal identity' : 'New Identity'}
      size="md"
    >
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
            placeholder="Acme prod appliance"
            required
          />
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
          <label className={labelCls}>
            Username <span className="text-destructive">*</span>
          </label>
          <input
            className={inputCls}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="admin"
            required
          />
        </div>

        <div>
          <label className={labelCls}>Authentication</label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <ToggleCard
              active={usePassword}
              icon={Lock}
              title="Password"
              description="Authenticate with a username and password."
              onClick={() => setUsePassword((v) => !v)}
            />
            <ToggleCard
              active={useKey}
              icon={KeyRound}
              title="Private key"
              description="Authenticate with an SSH key from the keystore."
              onClick={() => setUseKey((v) => !v)}
            />
          </div>
          {usePassword && useKey && (
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              Key is tried first, then password — also works for servers that require both.
            </p>
          )}
        </div>

        {usePassword && (
          <div>
            <label className={labelCls}>
              Password{' '}
              {isEdit && <span className="font-normal text-muted-foreground">(blank = keep current)</span>}
            </label>
            <PasswordInput
              className={inputCls}
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                if (e.target.value) setClearPassword(false);
              }}
              placeholder={isEdit ? '••••••••' : 'Enter password'}
              autoComplete="new-password"
            />
            {isEdit && identity?.hasPassword && !password && (
              <SwitchField
                className="mt-2"
                size="sm"
                label="Clear stored password"
                checked={clearPassword}
                onCheckedChange={setClearPassword}
              />
            )}
          </div>
        )}

        {useKey && (
          <div className="space-y-3 rounded-md border border-border p-3">
            <div className="flex gap-4 text-sm">
              <label className="flex cursor-pointer items-center gap-2">
                <input type="radio" checked={keyMode === 'existing'} onChange={() => setKeyMode('existing')} />
                Use existing key
              </label>
              <label className="flex cursor-pointer items-center gap-2">
                <input type="radio" checked={keyMode === 'new'} onChange={() => setKeyMode('new')} />
                Import new key
              </label>
              <label className="flex cursor-pointer items-center gap-2">
                <input type="radio" checked={keyMode === 'generate'} onChange={() => setKeyMode('generate')} />
                Generate new
              </label>
            </div>

            {keyMode === 'existing' && (
              <SearchableSelect
                value={sshKeyId}
                onChange={setSshKeyId}
                options={keys.map((k) => ({
                  value: k.id,
                  label: k.name,
                  sublabel: k.fingerprint,
                }))}
                placeholder="Select a key..."
                emptyMessage="No keys in keystore yet"
                clearable={false}
              />
            )}

            {keyMode === 'new' && (
              <PrivateKeyInput
                privateKey={privateKey}
                onPrivateKeyChange={setPrivateKey}
                passphrase={keyPassphrase}
                onPassphraseChange={setKeyPassphrase}
                rows={4}
                showHint={false}
              />
            )}

            {keyMode === 'generate' && (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-xs font-medium text-muted-foreground">Type</label>
                  <SearchableSelect
                    value={genKeyType}
                    onChange={setGenKeyType}
                    options={KEY_TYPES}
                    searchable={false}
                    clearable={false}
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-muted-foreground">
                    Bits <span className="font-normal">(optional)</span>
                  </label>
                  <input
                    className={inputCls}
                    value={genBits}
                    onChange={(e) => setGenBits(e.target.value)}
                    placeholder="default"
                  />
                </div>
              </div>
            )}
            {keyMode !== 'existing' && (
              <p className="text-[11px] text-muted-foreground">
                {keyMode === 'new' ? 'The imported' : 'The generated'} key is stored as &quot;{name.trim() || '<name>'} key&quot; and linked to this identity.
              </p>
            )}
          </div>
        )}

        <div data-sheet-footer className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={submitting}>
            {submitting ? 'Saving...' : isEdit ? 'Save changes' : 'Create identity'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export default IdentityFormModal;
