import { useState } from 'react';

const SSH_KEY_RE = /^(ssh-rsa|ssh-ed25519|ecdsa-sha2-)/;

function SshKeyDialog({ user, onSave, onRemove, onCancel }) {
  const [publicKey, setPublicKey] = useState('');
  const [replacing, setReplacing] = useState(false);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const existing = user?.sshPublicKey || user?.publicKey;
  const showEditor = !existing || replacing;

  const handleSave = async () => {
    setError('');
    const trimmed = publicKey.trim();
    if (!SSH_KEY_RE.test(trimmed)) {
      setError('Key must start with ssh-rsa, ssh-ed25519, or ecdsa-sha2-');
      return;
    }
    setSubmitting(true);
    try {
      await onSave(trimmed);
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message || 'Failed to save key');
    } finally {
      setSubmitting(false);
    }
  };

  const handleRemove = async () => {
    setSubmitting(true);
    try {
      await onRemove();
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message || 'Failed to remove key');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-4">
      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {existing && !replacing && (
        <div>
          <label className="mb-1.5 block text-sm font-medium text-foreground">Current key</label>
          <pre className="max-h-32 overflow-auto rounded-md border border-border bg-muted/30 p-3 text-xs text-foreground">
            {existing}
          </pre>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={() => setReplacing(true)}
              className="h-9 rounded-md border border-input bg-background px-4 text-sm font-medium text-foreground hover:bg-accent"
            >
              Replace
            </button>
            <button
              type="button"
              onClick={handleRemove}
              disabled={submitting}
              className="h-9 rounded-md bg-destructive px-4 text-sm font-medium text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50"
            >
              Remove key
            </button>
          </div>
        </div>
      )}

      {showEditor && (
        <div>
          <label className="mb-1.5 block text-sm font-medium text-foreground">Public key</label>
          <textarea
            rows={6}
            value={publicKey}
            onChange={(e) => setPublicKey(e.target.value)}
            placeholder="ssh-ed25519 AAAAC3... user@host"
            className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <div className="mt-3 flex justify-end gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="h-9 rounded-md border border-input bg-background px-4 text-sm font-medium text-foreground hover:bg-accent"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={submitting}
              className="h-9 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {submitting ? 'Saving...' : 'Save key'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default SshKeyDialog;
