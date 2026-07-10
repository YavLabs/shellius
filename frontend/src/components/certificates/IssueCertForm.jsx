import { useState, useEffect } from 'react';
import { X } from 'lucide-react';
import { listUsers } from '@/services/userService';
import { listServers } from '@/services/serverService';
import SearchableSelect from '@/components/ui/SearchableSelect';
import Avatar from '@/components/ui/Avatar';

function IssueCertForm({ onSubmit, onCancel }) {
  const [users, setUsers] = useState([]);
  const [servers, setServers] = useState([]);
  const [userId, setUserId] = useState('');
  const [serverId, setServerId] = useState('');
  const [principals, setPrincipals] = useState(['root']);
  const [principalInput, setPrincipalInput] = useState('');
  const [validityHours, setValidityHours] = useState(8);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const u = await listUsers({ page: 1, pageSize: 200 });
        setUsers(u.items || []);
      } catch {
        /* ignore */
      }
      try {
        const s = await listServers({ page: 1, pageSize: 200 });
        setServers(s.items || []);
      } catch {
        /* ignore */
      }
    })();
  }, []);

  const addPrincipal = () => {
    const v = principalInput.trim();
    if (!v) return;
    if (!principals.includes(v)) setPrincipals([...principals, v]);
    setPrincipalInput('');
  };

  const removePrincipal = (p) => {
    setPrincipals(principals.filter((x) => x !== p));
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addPrincipal();
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    if (!userId) {
      setError('User is required');
      return;
    }
    if (principals.length === 0) {
      setError('At least one principal is required');
      return;
    }
    const hours = Math.max(1, Math.min(168, Number(validityHours) || 8));
    const payload = {
      userId,
      principals,
      validitySeconds: hours * 3600,
    };
    if (serverId) payload.serverId = serverId;

    setSubmitting(true);
    try {
      await onSubmit(payload);
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message || 'Failed to issue certificate');
    } finally {
      setSubmitting(false);
    }
  };

  const inputCls =
    'h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring';

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="mb-1 block text-sm font-medium text-foreground">
          User <span className="text-destructive">*</span>
        </label>
        <SearchableSelect
          value={userId}
          onChange={(v) => setUserId(v)}
          options={users.map((u) => ({
            value: u.id,
            label: u.name || u.email,
            sublabel: u.email,
            avatarUrl: u.avatarUrl,
          }))}
          placeholder="Select a user..."
          clearable={false}
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

      <div>
        <label className="mb-1 block text-sm font-medium text-foreground">
          Server (optional)
        </label>
        <SearchableSelect
          value={serverId}
          onChange={(v) => setServerId(v)}
          options={servers.map((s) => ({
            value: s.id,
            label: s.displayName || s.hostname,
            sublabel: s.hostname,
          }))}
          placeholder="None"
          clearable={true}
        />
      </div>

      <div>
        <label className="mb-1 block text-sm font-medium text-foreground">
          Principals <span className="text-destructive">*</span>
        </label>
        <div className="flex flex-wrap gap-1.5 rounded-md border border-input bg-background p-2">
          {principals.map((p) => (
            <span
              key={p}
              className="inline-flex items-center gap-1 rounded-md bg-accent px-2 py-0.5 text-xs font-medium text-foreground"
            >
              {p}
              <button
                type="button"
                onClick={() => removePrincipal(p)}
                className="rounded-sm text-muted-foreground hover:text-foreground"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
          <input
            type="text"
            value={principalInput}
            onChange={(e) => setPrincipalInput(e.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={addPrincipal}
            placeholder="Type and press Enter"
            className="min-w-[120px] flex-1 bg-transparent text-sm text-foreground outline-none"
          />
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          Press Enter to add each principal.
        </p>
      </div>

      <div>
        <label className="mb-1 block text-sm font-medium text-foreground">
          Validity (hours)
        </label>
        <input
          type="number"
          min={1}
          max={168}
          value={validityHours}
          onChange={(e) => setValidityHours(e.target.value)}
          className={inputCls}
        />
        <p className="mt-1 text-xs text-muted-foreground">
          Max 168 hours (1 week). Default 8 hours.
        </p>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
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
          {submitting ? 'Issuing...' : 'Issue Certificate'}
        </button>
      </div>
    </form>
  );
}

export default IssueCertForm;
