import { useEffect, useState } from 'react';
import Modal from '@/components/shared/Modal';
import { Button } from '@/components/ui/button';
import PasswordInput from '@/components/ui/PasswordInput';
import SearchableSelect from '@/components/ui/SearchableSelect';
import { generateKey } from '@/services/keystoreService';

const KEY_TYPES = [
  { value: 'ed25519', label: 'ED25519 (recommended)' },
  { value: 'rsa', label: 'RSA' },
  { value: 'ecdsa', label: 'ECDSA' },
];

const BITS_BY_TYPE = {
  rsa: ['2048', '3072', '4096'],
  ecdsa: ['256', '384', '521'],
};

const inputCls =
  'h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring';
const labelCls = 'mb-1.5 block text-sm font-medium text-foreground';

function GenerateKeyModal({ open, onClose, onSaved }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [keyType, setKeyType] = useState('ed25519');
  const [bits, setBits] = useState('');
  const [comment, setComment] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName('');
    setDescription('');
    setKeyType('ed25519');
    setBits('');
    setComment('');
    setPassphrase('');
    setError('');
  }, [open]);

  const bitsOptions = BITS_BY_TYPE[keyType];

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!name.trim()) return setError('Name is required');
    setError('');
    setSubmitting(true);
    try {
      const key = await generateKey({
        name: name.trim(),
        description: description.trim() || undefined,
        keyType,
        bits: bits ? Number(bits) : undefined,
        comment: comment.trim() || undefined,
        passphrase: passphrase || undefined,
      });
      onSaved?.(key);
      onClose();
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message || 'Failed to generate key');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Generate SSH key" size="sm">
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
          <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} required />
        </div>
        <div>
          <label className={labelCls}>Description</label>
          <input className={inputCls} value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelCls}>Type</label>
            <SearchableSelect
              value={keyType}
              onChange={(v) => {
                setKeyType(v);
                setBits('');
              }}
              options={KEY_TYPES}
              searchable={false}
              clearable={false}
            />
          </div>
          {bitsOptions && (
            <div>
              <label className={labelCls}>Bits</label>
              <SearchableSelect
                value={bits}
                onChange={setBits}
                options={[{ value: '', label: 'Default' }, ...bitsOptions.map((b) => ({ value: b, label: b }))]}
                searchable={false}
                clearable={false}
              />
            </div>
          )}
        </div>
        <div>
          <label className={labelCls}>Comment</label>
          <input className={inputCls} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="user@shellius" />
        </div>
        <div>
          <label className={labelCls}>
            Passphrase <span className="font-normal text-muted-foreground">(optional)</span>
          </label>
          <PasswordInput className={inputCls} value={passphrase} onChange={(e) => setPassphrase(e.target.value)} autoComplete="new-password" />
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={submitting}>
            {submitting ? 'Generating...' : 'Generate key'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export default GenerateKeyModal;
