import { useState, useEffect } from 'react';
import { listUsers } from '@/services/userService';

const ROLES = ['super_admin', 'admin', 'manager', 'member'];
const STATUSES = ['active', 'invited', 'suspended', 'deactivated'];

function UserForm({ user, onSubmit, onCancel }) {
  const isEdit = !!user;
  const [name, setName] = useState(user?.name || '');
  const [email, setEmail] = useState(user?.email || '');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState(user?.role || 'member');
  const [status, setStatus] = useState(user?.status || 'active');
  const [managerId, setManagerId] = useState(user?.managerId || '');
  const [managers, setManagers] = useState([]);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Load candidate managers (everyone except the user being edited).
  useEffect(() => {
    listUsers({ pageSize: 200 })
      .then((res) => {
        const items = res?.items || res?.data?.items || res || [];
        setManagers((Array.isArray(items) ? items : []).filter((u) => u.id !== user?.id));
      })
      .catch(() => setManagers([]));
  }, [user?.id]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    if (!name.trim() || !email.trim()) {
      setError('Name and email are required');
      return;
    }
    const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRe.test(email)) {
      setError('Invalid email format');
      return;
    }
    if (!isEdit && password.length < 8) {
      setError('Password must be at least 8 characters');
      return;
    }
    const payload = { name: name.trim(), email: email.trim(), role };
    if (!isEdit) payload.password = password;
    if (isEdit) payload.status = status;
    if (managerId) payload.managerId = managerId;
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
    'h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring';

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <div>
        <label className="mb-1.5 block text-sm font-medium text-foreground">Name</label>
        <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} required />
      </div>

      <div>
        <label className="mb-1.5 block text-sm font-medium text-foreground">Email</label>
        <input
          type="email"
          className={inputCls}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
      </div>

      {!isEdit && (
        <div>
          <label className="mb-1.5 block text-sm font-medium text-foreground">Password</label>
          <input
            type="password"
            className={inputCls}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Minimum 8 characters"
            required
          />
        </div>
      )}

      <div>
        <label className="mb-1.5 block text-sm font-medium text-foreground">Role</label>
        <select className={inputCls} value={role} onChange={(e) => setRole(e.target.value)}>
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </div>

      {isEdit && (
        <div>
          <label className="mb-1.5 block text-sm font-medium text-foreground">Status</label>
          <select className={inputCls} value={status} onChange={(e) => setStatus(e.target.value)}>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
      )}

      <div>
        <label className="mb-1.5 block text-sm font-medium text-foreground">
          Manager <span className="text-muted-foreground">(optional)</span>
        </label>
        <select className={inputCls} value={managerId} onChange={(e) => setManagerId(e.target.value)}>
          <option value="">— None —</option>
          {managers.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name} ({m.email})
            </option>
          ))}
        </select>
      </div>

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
          {submitting ? 'Saving...' : isEdit ? 'Save changes' : 'Create user'}
        </button>
      </div>
    </form>
  );
}

export default UserForm;
