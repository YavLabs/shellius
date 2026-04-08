import { useEffect, useState } from 'react';
import { Lock, Unlock, Terminal, AlertTriangle } from 'lucide-react';
import Modal from '@/components/shared/Modal';
import EnvironmentBadge from '@/components/shared/EnvironmentBadge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import PrivateIPWarning from './PrivateIPWarning';
import { LINUX_USER_RE } from '@/utils/principal';

/**
 * ConnectModal
 *
 * Shown when the user already has an APPROVED, unexpired access request
 * for the target server. Lets them open a web terminal, with an optional
 * principal override (admin-only for arbitrary values; everyone can pick
 * between the AR's stored principal and the legacy sshUser).
 *
 * Props:
 *   open           boolean
 *   onClose        () => void
 *   server         server object (for display only)
 *   intent         output of getAccessIntent — MUST have hasActiveAccess=true
 *   currentUser    auth user (for admin role check)
 */
function ConnectModal({ open, onClose, server, intent, currentUser }) {
  const adminOverride = !!intent?.adminCanOverride;
  const allowed = intent?.allowedPrincipals || [];

  const [principal, setPrincipal] = useState(() => intent?.preferredPrincipal || '');
  const [overrideOn, setOverrideOn] = useState(false);

  // Reset on each open so a stale value from a previous render doesn't leak.
  useEffect(() => {
    if (open) {
      setPrincipal(intent?.preferredPrincipal || '');
      setOverrideOn(false);
    }
  }, [open, intent?.preferredPrincipal]);

  const trimmed = (principal || '').trim();
  const isValidFormat = LINUX_USER_RE.test(trimmed);
  const isInAllowList = allowed.includes(trimmed);
  const editable = adminOverride && overrideOn;

  // Non-admins are locked to the preferred principal OR must pick from
  // the allowed list via a select dropdown.
  const canSubmit =
    isValidFormat && (editable || isInAllowList || allowed.length === 0);

  const onConnect = () => {
    if (!canSubmit || !intent?.activeRequestId) return;
    const params = new URLSearchParams({ requestId: intent.activeRequestId });
    if (trimmed && trimmed !== intent.preferredPrincipal) {
      params.set('principal', trimmed);
    }
    window.open(`/terminal?${params.toString()}`, '_blank');
    onClose();
  };

  const proto = intent?.protocol || 'SSH';
  const port = server?.port || (proto === 'RDP' ? 3389 : 22);
  const jitBadge = intent?.jitEnabled && trimmed.endsWith('_jit');
  const isRdp = proto === 'RDP';

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={
        <span className="flex items-center gap-2">
          <Terminal className="h-4 w-4" />
          <span className="font-semibold">{server?.hostname}</span>
          {server?.environment && <EnvironmentBadge environment={server.environment} />}
          <span className="text-xs font-normal text-muted-foreground uppercase">{proto}</span>
        </span>
      }
      size="md"
    >
      <div className="space-y-4">
        <PrivateIPWarning ipAddress={server?.ipAddress} />

        {/* Connection details */}
        <div className="grid grid-cols-3 gap-3">
          <ReadOnlyField label="Host" value={server?.ipAddress || server?.hostname || '-'} />
          <ReadOnlyField label="Port" value={port} />
          <ReadOnlyField label="Protocol" value={proto} />
        </div>

        {/* Principal picker — only meaningful for SSH */}
        {!isRdp && (
          <div>
            <div className="mb-1 flex items-center justify-between">
              <label className="block text-xs font-medium text-muted-foreground">
                Connect as
              </label>
              {adminOverride && (
                <button
                  type="button"
                  onClick={() => setOverrideOn((v) => !v)}
                  className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
                  title={overrideOn ? 'Lock to preset principals' : 'Type a custom principal (admin)'}
                >
                  {overrideOn ? <Unlock className="h-3 w-3" /> : <Lock className="h-3 w-3" />}
                  {overrideOn ? 'Editable' : 'Use preset'}
                </button>
              )}
            </div>

            {editable ? (
              <Input
                value={principal}
                onChange={(e) => setPrincipal(e.target.value)}
                placeholder="ubuntu"
                autoComplete="off"
                spellCheck={false}
                className={
                  trimmed && !isValidFormat ? 'border-destructive focus-visible:ring-destructive' : ''
                }
              />
            ) : (
              <select
                value={principal}
                onChange={(e) => setPrincipal(e.target.value)}
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              >
                {allowed.map((p) => (
                  <option key={p} value={p}>
                    {p}
                    {p === intent?.preferredPrincipal ? '  (preferred)' : ''}
                  </option>
                ))}
              </select>
            )}

            {jitBadge && (
              <p className="mt-1 text-[11px] text-emerald-600 dark:text-emerald-400">
                JIT principal — target host will auto-create this user on connect.
              </p>
            )}
            {!adminOverride && allowed.length === 1 && (
              <p className="mt-1 text-[11px] text-muted-foreground">
                Only admins can use a different principal.
              </p>
            )}
            {trimmed && !isValidFormat && (
              <p className="mt-1 text-[11px] text-destructive">
                Invalid Linux username — lowercase letters, digits, underscore or hyphen, 1–32 chars.
              </p>
            )}
            {editable && isValidFormat && !isInAllowList && (
              <p className="mt-1 flex items-start gap-1 text-[11px] text-amber-600 dark:text-amber-400">
                <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
                Custom principal — this host has not been verified to have a user named
                <code className="ml-1 font-mono">{trimmed}</code>.
              </p>
            )}
          </div>
        )}

        {/* Expiry reminder */}
        {intent?.activeRequestId && (
          <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-400">
            Active access request {intent.breakGlass ? '(break-glass) ' : ''}—
            {' '}click Connect to open a web terminal.
          </div>
        )}

        {/* Footer */}
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={onConnect} disabled={!canSubmit}>
            Connect
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function ReadOnlyField({ label, value }) {
  return (
    <div>
      <label className="block text-xs font-medium text-muted-foreground mb-1">{label}</label>
      <div className="flex h-9 w-full rounded-md border border-input bg-muted/40 px-3 py-2 text-sm text-muted-foreground cursor-default select-text">
        {value}
      </div>
    </div>
  );
}

export default ConnectModal;
