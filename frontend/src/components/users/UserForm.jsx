import { useState, useEffect } from 'react';
import { listUsers } from '@/services/userService';
import api from '@/services/api';
import PasswordInput from '@/components/ui/PasswordInput';
import SearchableSelect from '@/components/ui/SearchableSelect';
import Avatar from '@/components/ui/Avatar';

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
  // 'email' = send a set-password invite; 'set' = admin sets the password now.
  const [pwMode, setPwMode] = useState('email');
  const [ssoEnabled, setSsoEnabled] = useState(false);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Load candidate managers (everyone except the user being edited).
  useEffect(() => {
    listUsers({ pageSize: 200 })
      .then((res) => {
        const items = res?.items || res?.data?.items || res || [];
        // Managers can only be super_admin / admin / manager (not members).
        const eligible = ['super_admin', 'admin', 'manager'];
        setManagers(
          (Array.isArray(items) ? items : []).filter(
            (u) => u.id !== user?.id && eligible.includes(u.role)
          )
        );
      })
      .catch(() => setManagers([]));
    // Whether SSO is configured — if so, new users sign in via SSO (no password).
    api
      .get('/auth/sso/public-status')
      .then((r) => setSsoEnabled(!!r.data?.data?.enabled))
      .catch(() => setSsoEnabled(false));
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

    const payload = { name: name.trim(), email: email.trim(), role };
    if (managerId) payload.managerId = managerId;

    if (isEdit) {
      payload.status = status;
    } else if (ssoEnabled) {
      // SSO configured — no password; send the "sign in with SSO" invite.
      payload.sendInvite = true;
    } else if (pwMode === 'set') {
      if (password.length < 8) {
        setError('Password must be at least 8 characters');
        return;
      }
      payload.password = password; // active immediately, no email
    } else {
      // Send a set-password email invite.
      payload.sendInvite = true;
    }

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
        <label className="mb-1.5 block text-sm font-medium text-foreground">Name <span className="text-destructive">*</span></label>
        <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} required />
      </div>

      <div>
        <label className="mb-1.5 block text-sm font-medium text-foreground">Email <span className="text-destructive">*</span></label>
        <input
          type="email"
          className={inputCls}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
      </div>

      {!isEdit && (
        ssoEnabled ? (
          <div className="rounded-md border border-blue-500/40 bg-blue-500/10 px-3 py-2 text-sm text-blue-700 dark:text-blue-300">
            SSO is configured — this user will sign in with single sign-on. No password is
            needed; they&apos;ll receive an invitation email.
          </div>
        ) : (
          <div className="space-y-2">
            <label className="block text-sm font-medium text-foreground">Password setup</label>
            <div className="flex flex-col gap-2">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="pwMode"
                  checked={pwMode === 'email'}
                  onChange={() => setPwMode('email')}
                  className="h-4 w-4 accent-primary"
                />
                Send the user an email to set their own password
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="pwMode"
                  checked={pwMode === 'set'}
                  onChange={() => setPwMode('set')}
                  className="h-4 w-4 accent-primary"
                />
                Set a password now
              </label>
            </div>
            {pwMode === 'set' && (
              <div>
                <label className="mb-1.5 block text-sm font-medium text-foreground">Password <span className="text-destructive">*</span></label>
                <PasswordInput
                  className={inputCls}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Minimum 8 characters"
                  autoComplete="new-password"
                />
              </div>
            )}
          </div>
        )
      )}

      <div>
        <label className="mb-1.5 block text-sm font-medium text-foreground">Role <span className="text-destructive">*</span></label>
        <SearchableSelect
          value={role}
          onChange={(v) => setRole(v)}
          options={ROLES.map((r) => ({ value: r, label: r }))}
          searchable={false}
          clearable={false}
        />
      </div>

      {isEdit && (
        <div>
          <label className="mb-1.5 block text-sm font-medium text-foreground">Status</label>
          <SearchableSelect
            value={status}
            onChange={(v) => setStatus(v)}
            options={STATUSES.map((s) => ({ value: s, label: s }))}
            searchable={false}
            clearable={false}
          />
        </div>
      )}

      <div>
        <label className="mb-1.5 block text-sm font-medium text-foreground">
          Manager <span className="text-muted-foreground">(optional)</span>
        </label>
        <SearchableSelect
          value={managerId}
          onChange={(v) => setManagerId(v)}
          options={managers.map((m) => ({
            value: m.id,
            label: m.name || m.email,
            sublabel: m.email,
            avatarUrl: m.avatarUrl,
          }))}
          placeholder="— None —"
          clearable={true}
          renderOption={(o) => (
            <span className="flex items-center gap-2">
              <Avatar size="xs" name={o.label} email={o.sublabel} src={o.avatarUrl} />
              <span className="min-w-0">
                <span className="block truncate">{o.label}</span>
                <span className="block truncate text-xs text-muted-foreground">{o.sublabel}</span>
              </span>
            </span>
          )}
          renderValue={(o) => (
            <span className="flex items-center gap-2">
              <Avatar size="xs" name={o.label} email={o.sublabel} src={o.avatarUrl} />
              <span className="truncate">{o.label}</span>
            </span>
          )}
        />
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
