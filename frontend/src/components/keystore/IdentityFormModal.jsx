import { useEffect, useState } from 'react';
import { Upload } from 'lucide-react';
import Modal from '@/components/shared/Modal';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import PasswordInput from '@/components/ui/PasswordInput';
import SearchableSelect from '@/components/ui/SearchableSelect';
import { createCredential, updateCredential, listKeys } from '@/services/keystoreService';

const AUTH_TYPES = [
  { value: 'password', label: 'Password' },
  { value: 'key', label: 'Private key' },
  { value: 'key_password', label: 'Key + password' },
];

const KEY_TYPES = [
  { value: 'ed25519', label: 'ED25519 (recommended)' },
  { value: 'rsa', label: 'RSA' },
  { value: 'ecdsa', label: 'ECDSA' },
];

const inputCls =
  'h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring';
const labelCls = 'mb-1.5 block text-sm font-medium text-foreground';

/**
 * IdentityFormModal — create/edit a Keystore Identity (Credential).
 *
 * Props:
 *   open, onClose, identity (edit target, or null for create), onSaved
 */
function IdentityFormModal({ open, onClose, identity, onSaved }) {
  const isEdit = !!identity;

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [username, setUsername] = useState('');
  const [authType, setAuthType] = useState('password');
  const [password, setPassword] = useState('');
  const [clearPassword, setClearPassword] = useState(false);

  // key selection: 'existing' | 'new' | 'generate' | '' (none, password-only)
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
    setAuthType(identity?.authType || 'password');
    setPassword('');
    setClearPassword(false);
    setKeyMode(identity?.sshKey ? 'existing' : 'existing');
    setSshKeyId(identity?.sshKey?.id || '');
    setPrivateKey('');
    setKeyPassphrase('');
    setGenKeyType('ed25519');
    setGenBits('');
    setError('');
    listKeys()
      .then(setKeys)
      .catch(() => setKeys([]));
  }, [open, identity]);

  const needsKey = authType === 'key' || authType === 'key_password';
  const needsPassword = authType === 'password' || authType === 'key_password';

  const handleFileUpload = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setPrivateKey(String(reader.result || ''));
    reader.readAsText(file);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');

    if (!name.trim()) return setError('Name is required');
    if (!username.trim()) return setError('Username is required');
    if (needsKey) {
      if (keyMode === 'existing' && !sshKeyId) return setError('Select a key');
      if (keyMode === 'new' && !privateKey.trim()) return setError('Paste or upload a private key');
    }

    const payload = {
      name: name.trim(),
      description: description.trim() || undefined,
      username: username.trim(),
      authType,
    };

    if (needsPassword) {
      if (password) payload.password = password;
      else if (isEdit && clearPassword) payload.clearPassword = true;
      // else: omitted -> keep existing on edit
    }

    if (needsKey) {
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
    <Modal open={open} onClose={onClose} title={isEdit ? 'Edit Identity' : 'New Identity'} size="md">
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
          <label className={labelCls}>Authentication type</label>
          <div className="flex gap-4">
            {AUTH_TYPES.map((t) => (
              <label key={t.value} className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
                <input
                  type="radio"
                  checked={authType === t.value}
                  onChange={() => setAuthType(t.value)}
                />
                {t.label}
              </label>
            ))}
          </div>
        </div>

        {needsPassword && (
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
              <label className="mt-1.5 flex items-center gap-2 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={clearPassword}
                  onChange={(e) => setClearPassword(e.target.checked)}
                  className="rounded border-border accent-primary"
                />
                Clear stored password
              </label>
            )}
          </div>
        )}

        {needsKey && (
          <div className="space-y-3 rounded-md border border-border p-3">
            <div className="flex gap-4 text-sm">
              <label className="flex cursor-pointer items-center gap-2">
                <input type="radio" checked={keyMode === 'existing'} onChange={() => setKeyMode('existing')} />
                Use existing key
              </label>
              <label className="flex cursor-pointer items-center gap-2">
                <input type="radio" checked={keyMode === 'new'} onChange={() => setKeyMode('new')} />
                Paste / upload key
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
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-medium text-muted-foreground">Private key</label>
                  <label className="flex cursor-pointer items-center gap-1 text-xs text-primary hover:underline">
                    <Upload className="h-3 w-3" />
                    Upload file
                    <input type="file" className="hidden" onChange={handleFileUpload} />
                  </label>
                </div>
                <textarea
                  rows={5}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                  value={privateKey}
                  onChange={(e) => setPrivateKey(e.target.value)}
                  placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                  spellCheck={false}
                />
                <PasswordInput
                  className={inputCls}
                  value={keyPassphrase}
                  onChange={(e) => setKeyPassphrase(e.target.value)}
                  placeholder="Passphrase (if encrypted)"
                  autoComplete="new-password"
                />
              </div>
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
            <p className="text-[11px] text-muted-foreground">
              A new key is stored as &quot;{name.trim() || '<name>'} key&quot; and linked to this identity.
            </p>
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
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
