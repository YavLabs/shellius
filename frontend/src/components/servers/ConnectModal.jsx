import { useEffect, useState } from 'react';
import { Lock, Unlock, Terminal, ExternalLink, AlertTriangle } from 'lucide-react';
import Modal from '@/components/shared/Modal';
import EnvironmentBadge from '@/components/shared/EnvironmentBadge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import PrivateIPWarning from './PrivateIPWarning';
import { LINUX_USER_RE } from '@/utils/principal';
import SearchableSelect from '@/components/ui/SearchableSelect';
import { updateConnectionIp } from '@/services/serverService';
import { useTerminalWorkspace } from '@/context/TerminalWorkspaceContext';

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
  const { openTab, openRdpTab } = useTerminalWorkspace();
  const adminOverride = !!intent?.adminCanOverride;
  const allowed = intent?.allowedPrincipals || [];
  const proto = intent?.protocol || 'SSH';
  const isRdp = proto === 'RDP';

  const [principal, setPrincipal] = useState(() => intent?.preferredPrincipal || '');
  const [overrideOn, setOverrideOn] = useState(false);
  const [ip, setIp] = useState(server?.ipAddress || '');
  const [ipErr, setIpErr] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [notice, setNotice] = useState('');

  // Reset on each open so a stale value from a previous render doesn't leak.
  useEffect(() => {
    if (open) {
      setPrincipal(intent?.preferredPrincipal || '');
      setOverrideOn(false);
      setIp(server?.ipAddress || '');
      setIpErr('');
      setNotice('');
    }
  }, [open, intent?.preferredPrincipal, server?.ipAddress]);

  const trimmed = (principal || '').trim();
  const isValidFormat = LINUX_USER_RE.test(trimmed);
  const isInAllowList = allowed.includes(trimmed);
  const editable = adminOverride && overrideOn;

  // RDP connects with the server-side rdpUsername injected by the gateway, so
  // the Linux-principal validation does not apply — an active request is enough.
  // For SSH, non-admins are locked to the preferred principal OR must pick from
  // the allowed list via a select dropdown.
  const canSubmit =
    isRdp || (isValidFormat && (editable || isInAllowList || allowed.length === 0));

  const ensureIpSaved = async () => {
    if (server?.dynamicIp && ip.trim() && ip.trim() !== server.ipAddress) {
      setConnecting(true);
      setIpErr('');
      try {
        await updateConnectionIp(server.id, ip.trim());
      } catch (e) {
        setIpErr(e.response?.data?.error?.message || 'Failed to update IP');
        setConnecting(false);
        return false;
      }
      setConnecting(false);
    }
    return true;
  };

  const onConnect = async () => {
    if (!canSubmit || !intent?.activeRequestId) return;
    if (!(await ensureIpSaved())) return;
    // RDP now lives in the workspace like SSH: the Guacamole keyboard is
    // bound to its own pane surface rather than to `document`, and
    // TerminalPaneArea renders RdpTerminal for RDP tabs.
    if (isRdp) {
      const { conflict } = openRdpTab(
        {
          requestId: intent.activeRequestId,
          serverId: server?.id,
          username: intent?.preferredPrincipal || undefined,
        },
        {
          label: server?.displayName || server?.hostname,
          env: server?.environment,
          host: server?.ipAddress || server?.hostname,
          focus: true,
        }
      );
      if (conflict) {
        // Windows allows one interactive session per account; a second pane
        // would evict the first. Say so rather than silently doing nothing.
        setNotice('This remote desktop is already open in a tab — switched to it.');
        return;
      }
      onClose();
      return;
    }
    openTab(
      { requestId: intent.activeRequestId, principal: trimmed && trimmed !== intent.preferredPrincipal ? trimmed : undefined },
      { label: server?.displayName || server?.hostname, env: server?.environment, host: server?.ipAddress || server?.hostname, focus: true }
    );
    onClose();
  };

  const onConnectNewWindow = async () => {
    if (!canSubmit || !intent?.activeRequestId) return;
    if (!(await ensureIpSaved())) return;
    const params = new URLSearchParams({ requestId: intent.activeRequestId });
    if (trimmed && trimmed !== intent.preferredPrincipal) params.set('principal', trimmed);
    window.open(`/terminal?${params.toString()}`, '_blank');
    onClose();
  };

  const port = server?.port || (proto === 'RDP' ? 3389 : 22);
  const jitBadge = intent?.jitEnabled && trimmed.endsWith('_jit');

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={
        <span className="flex items-center gap-2">
          <Terminal className="h-4 w-4" />
          <span className="font-semibold">{server?.displayName || server?.hostname}</span>
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
          {server?.dynamicIp ? (
            <div>
              <p className="mb-1 text-xs font-medium text-muted-foreground">Host (IP)</p>
              <input
                className="h-8 w-full rounded-md border border-input bg-background px-2 font-mono text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                value={ip}
                onChange={(e) => setIp(e.target.value)}
                placeholder={server?.ipAddress || 'current IP'}
              />
            </div>
          ) : (
            <ReadOnlyField label="Host" value={server?.ipAddress || server?.hostname || '-'} />
          )}
          <ReadOnlyField label="Port" value={port} />
          <ReadOnlyField label="Protocol" value={proto} />
        </div>
        {server?.dynamicIp && (
          <p className="-mt-2 text-xs text-muted-foreground">
            This server&apos;s IP can change. Confirm or update it before connecting.
          </p>
        )}
        {ipErr && <p className="text-xs text-destructive">{ipErr}</p>}
        {notice && (
          <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            {notice}
          </p>
        )}

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
              <SearchableSelect
                value={principal}
                onChange={(v) => setPrincipal(v)}
                options={allowed.map((p) => ({
                  value: p,
                  label: p,
                  sublabel: p === intent?.preferredPrincipal ? 'preferred' : undefined,
                }))}
                searchable={false}
                clearable={false}
              />
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
        <div data-sheet-footer className="flex items-center justify-end gap-2 pt-1">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          {/* A remote desktop always opens in its own window — see onConnect.
              Offering "New window" beside it would imply the other button
              does something different. */}
          {!isRdp && (
            <Button
              variant="outline"
              title="Open in a new browser window instead of a workspace tab"
              onClick={onConnectNewWindow}
              disabled={!canSubmit || connecting || (server?.dynamicIp && !ip.trim())}
            >
              <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
              New window
            </Button>
          )}
          <Button
            onClick={onConnect}
            disabled={!canSubmit || connecting || (server?.dynamicIp && !ip.trim())}
            title={isRdp ? 'Remote desktop opens in its own window' : undefined}
          >
            {isRdp && <ExternalLink className="mr-1.5 h-3.5 w-3.5" />}
            {connecting ? 'Updating IP…' : isRdp ? 'Open remote desktop' : 'Connect'}
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
