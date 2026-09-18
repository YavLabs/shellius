import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import Modal from '@/components/shared/Modal';
import { Button } from '@/components/ui/button';
import PrivateKeyInput from './PrivateKeyInput';
import { importKey } from '@/services/keystoreService';

const inputCls =
  'h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring';
const labelCls = 'mb-1.5 block text-sm font-medium text-foreground';
const textareaCls =
  'w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-ring';

function ImportKeyModal({ open, onClose, onSaved }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [moreOpen, setMoreOpen] = useState(false);
  const [privateKey, setPrivateKey] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [publicKey, setPublicKey] = useState('');
  const [certificate, setCertificate] = useState('');
  const [inspectState, setInspectState] = useState({ result: null, error: null, inspecting: false });

  const [fieldErrors, setFieldErrors] = useState({});
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName('');
    setDescription('');
    setMoreOpen(false);
    setPrivateKey('');
    setPassphrase('');
    setPublicKey('');
    setCertificate('');
    setInspectState({ result: null, error: null, inspecting: false });
    setFieldErrors({});
    setError('');
  }, [open]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setFieldErrors({});
    if (!name.trim()) return setError('Label is required');
    if (!privateKey.trim()) return setError('Paste, drop, or upload a private key');
    setSubmitting(true);
    try {
      const key = await importKey({
        name: name.trim(),
        description: description.trim() || undefined,
        privateKey: privateKey.trim(),
        passphrase: passphrase || undefined,
        publicKey: publicKey.trim() || undefined,
        certificate: certificate.trim() || undefined,
      });
      onSaved?.(key);
      onClose();
    } catch (err) {
      const code = err.response?.data?.error?.code;
      const message = err.response?.data?.error?.message || err.message || 'Failed to import key';
      if (code === 'KEY_PUBLIC_MISMATCH') {
        setFieldErrors({ publicKey: message });
      } else if (code === 'CERT_INVALID' || code === 'CERT_KEY_MISMATCH') {
        setFieldErrors({ certificate: message });
      } else {
        setError(message);
      }
    } finally {
      setSubmitting(false);
    }
  };

  const canSubmit = !!name.trim() && !!privateKey.trim() && !inspectState.inspecting && !submitting;

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
            Label <span className="text-destructive">*</span>
          </label>
          <input
            className={inputCls}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Acme jump host key"
          />
        </div>

        <PrivateKeyInput
          privateKey={privateKey}
          onPrivateKeyChange={setPrivateKey}
          passphrase={passphrase}
          onPassphraseChange={setPassphrase}
          onPublicKeyDetected={setPublicKey}
          onCertificateDetected={setCertificate}
          onNameHint={(hint) => setName((n) => n || hint)}
          onInspectChange={setInspectState}
        />

        <div>
          <label className={labelCls}>
            Public key <span className="font-normal text-muted-foreground">(optional)</span>
          </label>
          <textarea
            rows={3}
            className={textareaCls}
            value={publicKey}
            onChange={(e) => setPublicKey(e.target.value)}
            placeholder="ssh-ed25519 AAAA..."
            spellCheck={false}
          />
          {fieldErrors.publicKey && (
            <p className="mt-1 text-xs text-destructive">{fieldErrors.publicKey}</p>
          )}
        </div>

        <div>
          <label className={labelCls}>
            Certificate <span className="font-normal text-muted-foreground">(optional — OpenSSH user certificate)</span>
          </label>
          <textarea
            rows={3}
            className={textareaCls}
            value={certificate}
            onChange={(e) => setCertificate(e.target.value)}
            placeholder="ssh-ed25519-cert-v01@openssh.com AAAA..."
            spellCheck={false}
          />
          {fieldErrors.certificate && (
            <p className="mt-1 text-xs text-destructive">{fieldErrors.certificate}</p>
          )}
        </div>

        <div>
          <button
            type="button"
            onClick={() => setMoreOpen((o) => !o)}
            className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            {moreOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            More options
          </button>
          {moreOpen && (
            <div className="mt-2">
              <label className={labelCls}>Description</label>
              <textarea
                rows={2}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={!canSubmit}>
            {submitting ? 'Importing...' : 'Import key'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export default ImportKeyModal;
