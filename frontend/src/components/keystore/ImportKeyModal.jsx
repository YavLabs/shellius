import { useEffect, useState } from 'react';
import { Upload } from 'lucide-react';
import Modal from '@/components/shared/Modal';
import { Button } from '@/components/ui/button';
import PasswordInput from '@/components/ui/PasswordInput';
import { importKey } from '@/services/keystoreService';

const inputCls =
  'h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring';
const labelCls = 'mb-1.5 block text-sm font-medium text-foreground';

function ImportKeyModal({ open, onClose, onSaved }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName('');
    setDescription('');
    setPrivateKey('');
    setPassphrase('');
    setError('');
  }, [open]);

  const handleFileUpload = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setPrivateKey(String(reader.result || ''));
    reader.readAsText(file);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!name.trim()) return setError('Name is required');
    if (!privateKey.trim()) return setError('Paste or upload a private key');
    setError('');
    setSubmitting(true);
    try {
      const key = await importKey({
        name: name.trim(),
        description: description.trim() || undefined,
        privateKey: privateKey.trim(),
        passphrase: passphrase || undefined,
      });
      onSaved?.(key);
      onClose();
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message || 'Failed to import key');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Import SSH key" size="sm">
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
        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <label className="text-sm font-medium text-foreground">
              Private key <span className="text-destructive">*</span>
            </label>
            <label className="flex cursor-pointer items-center gap-1 text-xs text-primary hover:underline">
              <Upload className="h-3 w-3" />
              Upload file
              <input type="file" className="hidden" onChange={handleFileUpload} />
            </label>
          </div>
          <textarea
            rows={6}
            className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            value={privateKey}
            onChange={(e) => setPrivateKey(e.target.value)}
            placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
            spellCheck={false}
            required
          />
        </div>
        <div>
          <label className={labelCls}>
            Passphrase <span className="font-normal text-muted-foreground">(if encrypted)</span>
          </label>
          <PasswordInput className={inputCls} value={passphrase} onChange={(e) => setPassphrase(e.target.value)} autoComplete="new-password" />
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={submitting}>
            {submitting ? 'Importing...' : 'Import key'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export default ImportKeyModal;
