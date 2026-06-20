import { useState, useEffect } from 'react';

function slugify(value) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function CustomerForm({ customer, onSubmit, onCancel }) {
  const isEdit = !!customer;
  const [name, setName] = useState(customer?.name || '');
  const [slug, setSlug] = useState(customer?.slug || '');
  const [slugTouched, setSlugTouched] = useState(isEdit);
  const [description, setDescription] = useState(customer?.description || '');
  const [isActive, setIsActive] = useState(customer?.isActive ?? true);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!isEdit && !slugTouched) {
      setSlug(slugify(name));
    }
  }, [name, isEdit, slugTouched]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    const trimmedName = name.trim();
    if (trimmedName.length < 2 || trimmedName.length > 100) {
      setError('Name must be between 2 and 100 characters');
      return;
    }
    if (!isEdit) {
      if (!/^[a-z0-9-]{3,30}$/.test(slug)) {
        setError('Slug must be 3-30 chars: lowercase letters, numbers, hyphens');
        return;
      }
    }
    const payload = { name: trimmedName, description: description.trim() };
    if (!isEdit) payload.slug = slug;
    if (isEdit) payload.isActive = isActive;
    setSubmitting(true);
    try {
      await onSubmit(payload);
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message || 'Failed to save');
    } finally {
      setSubmitting(false);
    }
  };

  const inputCls =
    'h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-60';

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <div>
        <label className="mb-1.5 block text-sm font-medium text-foreground">Name <span className="text-destructive">*</span></label>
        <input
          className={inputCls}
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
      </div>

      <div>
        <label className="mb-1.5 block text-sm font-medium text-foreground">Slug <span className="text-destructive">*</span></label>
        <input
          className={`${inputCls} font-mono`}
          value={slug}
          disabled={isEdit}
          onChange={(e) => {
            setSlugTouched(true);
            setSlug(e.target.value);
          }}
          placeholder="acme-corp"
          required={!isEdit}
        />
        {isEdit && (
          <p className="mt-1 text-xs text-muted-foreground">
            Slug cannot be changed after creation.
          </p>
        )}
      </div>

      <div>
        <label className="mb-1.5 block text-sm font-medium text-foreground">Description</label>
        <textarea
          rows={3}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>

      {isEdit && (
        <label className="flex items-center gap-2 text-sm text-foreground">
          <input
            type="checkbox"
            checked={isActive}
            onChange={(e) => setIsActive(e.target.checked)}
            className="h-4 w-4 rounded border-input"
          />
          Active
        </label>
      )}

      <div className="flex justify-end gap-2 pt-2">
        <button
          type="button"
          onClick={onCancel}
          className="h-9 rounded-md border border-input bg-background px-4 text-sm font-medium text-foreground hover:bg-accent"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={submitting}
          className="h-9 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {submitting ? 'Saving...' : isEdit ? 'Save changes' : 'Create customer'}
        </button>
      </div>
    </form>
  );
}

export default CustomerForm;
