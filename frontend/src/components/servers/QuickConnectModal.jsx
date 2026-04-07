import { useState } from 'react';
import Modal from '@/components/shared/Modal';
import EnvironmentBadge from '@/components/shared/EnvironmentBadge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { createAccessRequest } from '@/services/accessRequestService';
import { LINUX_USER_RE, defaultPrincipal } from '@/utils/principal';

const DURATION_OPTIONS = [
  { label: '15 minutes', seconds: 15 * 60 },
  { label: '1 hour', seconds: 60 * 60 },
  { label: '4 hours', seconds: 4 * 60 * 60 },
  { label: '8 hours', seconds: 8 * 60 * 60 },
];

const labelCls = 'block text-xs font-medium text-muted-foreground mb-1';
const roFieldCls =
  'flex h-9 w-full rounded-md border border-input bg-muted/40 px-3 py-2 text-sm text-muted-foreground cursor-default select-text';
const selectCls =
  'flex h-9 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring';

/**
 * QuickConnectModal
 *
 * Props:
 *   open          boolean
 *   onClose       () => void
 *   server        server object
 *   currentUser   auth user object
 *   activeRequest approved access request row | null
 */
function QuickConnectModal({ open, onClose, server, currentUser, activeRequest }) {
  const isConnectMode = !!activeRequest;

  const [principal, setPrincipal] = useState(
    () => activeRequest?.requestedPrincipal || defaultPrincipal(currentUser)
  );
  const [reason, setReason] = useState('');
  const [durationSeconds, setDurationSeconds] = useState(DURATION_OPTIONS[1].seconds);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [pendingBanner, setPendingBanner] = useState(false);

  const principalInvalid = principal.trim() !== '' && !LINUX_USER_RE.test(principal.trim());

  const handleConnect = async () => {
    setError('');
    const trimmedPrincipal = principal.trim();

    if (!LINUX_USER_RE.test(trimmedPrincipal)) {
      setError('Principal must be a valid Linux username (lowercase letters, digits, _ or -, 1-32 chars).');
      return;
    }

    if (isConnectMode) {
      window.open(`/terminal?requestId=${activeRequest.id}`, '_blank');
      onClose();
      return;
    }

    // Request mode
    if (!reason || reason.trim().length < 10) {
      setError('Reason must be at least 10 characters.');
      return;
    }

    setSubmitting(true);
    try {
      const newAr = await createAccessRequest({
        serverId: server.id,
        reason: reason.trim(),
        requestedDuration: durationSeconds,
        requestedPrincipal: trimmedPrincipal,
        protocol: server.protocol || 'SSH',
      });

      if (newAr?.status === 'APPROVED' && newAr?.id) {
        window.open(`/terminal?requestId=${newAr.id}`, '_blank');
        onClose();
      } else {
        setPendingBanner(true);
        setTimeout(() => {
          setPendingBanner(false);
          onClose();
        }, 3000);
      }
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message || 'Failed to submit request.');
    } finally {
      setSubmitting(false);
    }
  };

  const proto = server?.protocol || 'SSH';
  const port = server?.port || (proto === 'RDP' ? 3389 : 22);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={
        <span className="flex items-center gap-2">
          <span className="font-semibold">{server?.hostname}</span>
          {server?.environment && <EnvironmentBadge environment={server.environment} />}
          <span className="text-xs font-normal text-muted-foreground uppercase">{proto}</span>
        </span>
      }
      size="md"
    >
      <div className="space-y-4">
        {/* Read-only connection info */}
        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className={labelCls}>Host</label>
            <div className={roFieldCls}>{server?.ipAddress || server?.hostname || '-'}</div>
          </div>
          <div>
            <label className={labelCls}>Port</label>
            <div className={roFieldCls}>{port}</div>
          </div>
          <div>
            <label className={labelCls}>Protocol</label>
            <div className={roFieldCls}>{proto}</div>
          </div>
        </div>

        {/* Connect as */}
        <div>
          <label className={labelCls}>Connect as</label>
          <Input
            value={principal}
            onChange={(e) => setPrincipal(e.target.value)}
            placeholder="ubuntu"
            autoComplete="off"
            spellCheck={false}
            className={principalInvalid ? 'border-destructive focus-visible:ring-destructive' : ''}
          />
          {principalInvalid && (
            <p className="mt-1 text-[11px] text-destructive">
              Must be a valid Linux username: lowercase letters, digits, _ or -, starts with letter or _.
            </p>
          )}
        </div>

        {/* Request mode fields */}
        {!isConnectMode && (
          <>
            <div>
              <label className={labelCls}>Reason</label>
              <textarea
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring min-h-[70px] resize-none"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Why do you need access? (min 10 characters)"
                rows={3}
              />
            </div>
            <div>
              <label className={labelCls}>Duration</label>
              <select
                className={selectCls}
                value={String(durationSeconds)}
                onChange={(e) => setDurationSeconds(Number(e.target.value))}
              >
                {DURATION_OPTIONS.map((opt) => (
                  <option key={opt.seconds} value={String(opt.seconds)}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
          </>
        )}

        {/* Pending banner */}
        {pendingBanner && (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
            Request submitted — awaiting manager approval.
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        {/* Footer */}
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={handleConnect} disabled={submitting || principalInvalid}>
            {submitting
              ? 'Submitting...'
              : isConnectMode
              ? 'Connect'
              : 'Request Access'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export default QuickConnectModal;
