import { useState, useEffect, useCallback } from 'react';
import Modal from '@/components/shared/Modal';
import EnvironmentBadge from '@/components/shared/EnvironmentBadge';
import { createAccessRequest, getAccessIntent } from '@/services/accessRequestService';
import { listServers } from '@/services/serverService';
import { useAuth } from '@/context/AuthContext';
import { LINUX_USER_RE, defaultPrincipal } from '@/utils/principal';
import PrivateIPWarning from '@/components/servers/PrivateIPWarning';
import SearchableSelect from '@/components/ui/SearchableSelect';

const DURATION_UNITS = [
  { label: 'minutes', value: 'minutes', factor: 60 },
  { label: 'hours', value: 'hours', factor: 3600 },
];

function toSeconds(amount, unit) {
  const u = DURATION_UNITS.find((u) => u.value === unit);
  return Math.floor(Number(amount) * (u?.factor ?? 60));
}

const inputCls =
  'w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50';
const labelCls = 'block text-xs font-medium text-muted-foreground mb-1';

function RequestForm({ open, onClose, onSuccess, initialServerId = '' }) {
  const { user } = useAuth();

  const [servers, setServers] = useState([]);
  const [loadingServers, setLoadingServers] = useState(false);

  const [serverId, setServerId] = useState('');
  const [reason, setReason] = useState('');
  const [durationAmount, setDurationAmount] = useState('1');
  const [durationUnit, setDurationUnit] = useState('hours');
  const [principal, setPrincipal] = useState('');
  const [protocol, setProtocol] = useState('SSH');

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const fetchServers = useCallback(async () => {
    setLoadingServers(true);
    try {
      const data = await listServers({ limit: 200 });
      const items = data?.items || data || [];
      setServers(items);
    } catch {
      setServers([]);
    } finally {
      setLoadingServers(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      fetchServers();
      setServerId(initialServerId || '');
      setReason('');
      setDurationAmount('1');
      setDurationUnit('hours');
      setPrincipal(defaultPrincipal(user));
      setProtocol('SSH');
      setError('');
    }
  }, [open, fetchServers, user, initialServerId]);

  // Whenever the selected server changes, fetch the access-intent so we
  // can preload a JIT-aware principal and the right protocol. This is
  // what makes the Request Access button on the Servers page behave
  // intelligently (pre-selects the server + the JIT principal if any).
  useEffect(() => {
    if (!open || !serverId) return;
    let cancelled = false;
    getAccessIntent(serverId)
      .then((intent) => {
        if (cancelled || !intent) return;
        if (intent.preferredPrincipal) setPrincipal(intent.preferredPrincipal);
        if (intent.protocol === 'SSH' || intent.protocol === 'RDP') {
          setProtocol(intent.protocol);
        }
      })
      .catch(() => {
        // Non-fatal — fall back to the static default already set.
      });
    return () => {
      cancelled = true;
    };
  }, [open, serverId]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');

    if (!serverId) {
      setError('Please select a server.');
      return;
    }
    if (!reason || reason.trim().length < 10) {
      setError('Reason must be at least 10 characters.');
      return;
    }
    const trimmedPrincipal = principal.trim();
    if (!LINUX_USER_RE.test(trimmedPrincipal)) {
      setError(
        'Principal must be a valid Linux username: lowercase letters, digits, underscore, or hyphen (1-32 chars, must start with a letter or underscore).'
      );
      return;
    }
    const requestedDuration = toSeconds(durationAmount, durationUnit);
    if (!requestedDuration || requestedDuration <= 0) {
      setError('Enter a valid duration.');
      return;
    }

    setSubmitting(true);
    try {
      await createAccessRequest({
        serverId,
        reason: reason.trim(),
        requestedDuration,
        requestedPrincipal: trimmedPrincipal,
        protocol,
      });
      onSuccess?.();
      onClose();
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message || 'Failed to submit request.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="New Access Request" size="md">
      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Server */}
        <div>
          <label className={labelCls}>Server <span className="text-destructive">*</span></label>
          <SearchableSelect
            value={serverId}
            onChange={(v) => setServerId(v)}
            options={servers.map((s) => ({
              value: s.id,
              label: s.displayName || s.hostname || s.name,
              sublabel: s.hostname,
              environment: s.environment,
            }))}
            placeholder={loadingServers ? 'Loading servers...' : 'Select a server'}
            disabled={loadingServers}
            clearable={false}
          />
          {serverId && (() => {
            const sel = servers.find((s) => s.id === serverId);
            return sel ? (
              <div className="mt-2">
                <PrivateIPWarning ipAddress={sel.ipAddress} />
              </div>
            ) : null;
          })()}
        </div>

        {/* Protocol */}
        <div>
          <label className={labelCls}>Protocol</label>
          <div className="flex gap-4">
            {['SSH', 'RDP'].map((p) => (
              <label key={p} className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="protocol"
                  value={p}
                  checked={protocol === p}
                  onChange={() => setProtocol(p)}
                  className="h-4 w-4 accent-primary"
                />
                <span className="text-sm text-foreground">{p}</span>
              </label>
            ))}
          </div>
        </div>

        {/* Reason */}
        <div>
          <label className={labelCls}>Reason <span className="text-destructive">*</span></label>
          <textarea
            className={`${inputCls} min-h-20 resize-none`}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Describe why you need access (min 10 characters)..."
            rows={3}
          />
        </div>

        {/* Duration */}
        <div>
          <label className={labelCls}>Duration <span className="text-destructive">*</span></label>
          <div className="flex gap-2">
            <input
              type="number"
              className={`${inputCls} w-24`}
              min="1"
              value={durationAmount}
              onChange={(e) => setDurationAmount(e.target.value)}
            />
            <SearchableSelect
              value={durationUnit}
              onChange={(v) => setDurationUnit(v)}
              options={DURATION_UNITS.map((u) => ({ value: u.value, label: u.label }))}
              searchable={false}
              clearable={false}
            />
          </div>
        </div>

        {/* Principal */}
        <div>
          <label className={labelCls}>Requested Principal (SSH username) <span className="text-destructive">*</span></label>
          <input
            type="text"
            className={`${inputCls} ${
              principal && !LINUX_USER_RE.test(principal.trim())
                ? 'border-destructive focus:ring-destructive'
                : ''
            }`}
            value={principal}
            onChange={(e) => setPrincipal(e.target.value)}
            placeholder="ubuntu"
            autoComplete="off"
            spellCheck={false}
          />
          <p className="mt-1 text-[11px] text-muted-foreground">
            Must match an existing Linux user on the target host. Lowercase
            letters, digits, underscore, or hyphen (1-32 chars).
          </p>
          {principal && !LINUX_USER_RE.test(principal.trim()) && (
            <p className="mt-1 text-[11px] text-destructive">
              Invalid Linux username — example valid values:{' '}
              <code className="font-mono">ubuntu</code>,{' '}
              <code className="font-mono">ec2-user</code>,{' '}
              <code className="font-mono">yavadmin</code>.
            </p>
          )}
        </div>

        {error && (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground hover:bg-accent"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {submitting ? 'Submitting...' : 'Submit Request'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export default RequestForm;
