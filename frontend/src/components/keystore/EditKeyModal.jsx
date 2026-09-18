import { useEffect, useState } from 'react';
import Modal from '@/components/shared/Modal';
import { Button } from '@/components/ui/button';
import { updateKey } from '@/services/keystoreService';

const inputCls =
  'h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring';
const labelCls = 'mb-1.5 block text-sm font-medium text-foreground';

function EditKeyModal({ open, onClose, sshKey, onSaved }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [comment, setComment] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(sshKey?.name || '');
    setDescription(sshKey?.description || '');
    setComment(sshKey?.comment || '');
    setError('');
  }, [open, sshKey]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!name.trim()) return setError('Name is required');
    setError('');
    setSubmitting(true);
    try {
      const key = await updateKey(sshKey.id, {
        name: name.trim(),
        description: description.trim() || undefined,
        comment: comment.trim() || undefined,
      });
      onSaved?.(key);
      onClose();
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message || 'Failed to save key');
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
        <div className="flex justify-end gap-2 pt-1">
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
