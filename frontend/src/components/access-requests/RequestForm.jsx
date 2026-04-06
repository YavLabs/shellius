import { useState, useEffect, useCallback } from 'react';
import Modal from '@/components/shared/Modal';
import EnvironmentBadge from '@/components/shared/EnvironmentBadge';
import { createAccessRequest } from '@/services/accessRequestService';
import { listServers } from '@/services/serverService';
import { useAuth } from '@/context/AuthContext';

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
const selectCls =
  'rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring';

function RequestForm({ open, onClose, onSuccess }) {
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
      setServerId('');
      setReason('');
      setDurationAmount('1');
      setDurationUnit('hours');
      setPrincipal(user?.username || user?.name || 'ubuntu');
      setProtocol('SSH');
      setError('');
    }
  }, [open, fetchServers, user]);

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
        requestedPrincipal: principal.trim() || 'ubuntu',
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
          <label className={labelCls}>Server</label>
          <select
            className={`${selectCls} w-full`}
            value={serverId}
            onChange={(e) => setServerId(e.target.value)}
            disabled={loadingServers}
          >
            <option value="">
              {loadingServers ? 'Loading servers...' : 'Select a server'}
            </option>
            {servers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.hostname || s.name} ({s.environment || 'unknown'})
              </option>
            ))}
          </select>
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
          <label className={labelCls}>Reason</label>
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
          <label className={labelCls}>Duration</label>
          <div className="flex gap-2">
            <input
              type="number"
              className={`${inputCls} w-24`}
              min="1"
              value={durationAmount}
              onChange={(e) => setDurationAmount(e.target.value)}
            />
            <select
              className={selectCls}
              value={durationUnit}
              onChange={(e) => setDurationUnit(e.target.value)}
            >
              {DURATION_UNITS.map((u) => (
                <option key={u.value} value={u.value}>
                  {u.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Principal */}
        <div>
          <label className={labelCls}>Requested Principal (SSH username)</label>
          <input
            type="text"
            className={inputCls}
            value={principal}
            onChange={(e) => setPrincipal(e.target.value)}
            placeholder="ubuntu"
          />
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
