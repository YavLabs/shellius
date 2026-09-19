import { useEffect, useState } from 'react';
import Modal from '@/components/shared/Modal';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { updateKey, getKey } from '@/services/keystoreService';

const inputCls =
  'h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring';
const labelCls = 'mb-1.5 block text-sm font-medium text-foreground';
const textareaCls =
  'w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-ring';

function EditKeyModal({ open, onClose, sshKey, onSaved }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [comment, setComment] = useState('');
  const [certificate, setCertificate] = useState('');
  const [clearCertificate, setClearCertificate] = useState(false);
  const [error, setError] = useState('');
  const [certError, setCertError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [certSummary, setCertSummary] = useState(null);
  const [originalCertText, setOriginalCertText] = useState('');

  useEffect(() => {
    if (!open) return;
    setName(sshKey?.name || '');
    setDescription(sshKey?.description || '');
    setComment(sshKey?.comment || '');
    setCertificate('');
    setOriginalCertText('');
    setCertSummary(sshKey?.certificate || null);
    setClearCertificate(false);
    setError('');
    setCertError('');
    if (sshKey?.id) {
      getKey(sshKey.id)
        .then((data) => {
          const text = data?.key?.certificateText || '';
          setCertificate(text);
          setOriginalCertText(text);
          setCertSummary(data?.key?.certificate || null);
        })
        .catch(() => {
          /* fall back to summary already set from the row */
        });
    }
  }, [open, sshKey]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!name.trim()) return setError('Name is required');
    setError('');
    setCertError('');
    setSubmitting(true);
    try {
      const payload = {
        name: name.trim(),
        description: description.trim() || undefined,
        comment: comment.trim() || undefined,
      };
      if (clearCertificate) {
        payload.certificate = null;
      } else if (certificate.trim() && certificate.trim() !== originalCertText) {
        payload.certificate = certificate.trim();
      }
      const key = await updateKey(sshKey.id, payload);
      onSaved?.(key);
      onClose();
    } catch (err) {
      const code = err.response?.data?.error?.code;
      const message = err.response?.data?.error?.message || err.message || 'Failed to save key';
      if (code === 'CERT_INVALID' || code === 'CERT_KEY_MISMATCH') {
        setCertError(message);
      } else {
        setError(message);
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Edit key" size="sm">
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
          <label className={labelCls}>Comment</label>
          <input className={inputCls} value={comment} onChange={(e) => setComment(e.target.value)} />
        </div>
        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <label className="text-sm font-medium text-foreground">
              Certificate <span className="font-normal text-muted-foreground">(optional)</span>
            </label>
            {(originalCertText || certificate) && (
              <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
                <Checkbox
                  checked={clearCertificate}
                  onChange={(e) => {
                    setClearCertificate(e.target.checked);
                    if (e.target.checked) setCertificate('');
                  }}
                />
                Clear certificate
              </label>
            )}
          </div>
          <textarea
            rows={3}
            className={textareaCls}
            value={certificate}
            onChange={(e) => {
              setCertificate(e.target.value);
              setClearCertificate(false);
            }}
            placeholder="ssh-ed25519-cert-v01@openssh.com AAAA..."
            spellCheck={false}
            disabled={clearCertificate}
          />
          {certError && <p className="mt-1 text-xs text-destructive">{certError}</p>}
          {certSummary && !clearCertificate && (
            <p className="mt-1 text-[11px] text-muted-foreground">
              Currently certified: {certSummary.keyId || 'unnamed'} — valid until{' '}
              {certSummary.validBefore ? new Date(certSummary.validBefore).toLocaleString() : 'unknown'}
              {certSummary.expired ? ' (expired)' : ''}
            </p>
          )}
        </div>
        <div data-sheet-footer className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={submitting}>
            {submitting ? 'Saving...' : 'Save changes'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export default EditKeyModal;
