import { useState, useEffect, useCallback } from 'react';
import { Laptop, Terminal as TerminalIcon, Smartphone, Loader2, LogOut } from 'lucide-react';
import { Button } from '@/components/ui/button';
import ConfirmDialog from '@/components/shared/ConfirmDialog';
import Skeleton from '@/components/ui/Skeleton';
import { Badge } from '@/components/ui/badge';
import { listAuthSessions, revokeAuthSession, revokeOtherAuthSessions } from '@/services/authSessionService';
import { describeSession } from '@/utils/userAgent';
import { relativeTime, formatDateTime } from '@/utils/time';

function SectionCard({ title, description, children }) {
  return (
    <div className="rounded-lg border border-border bg-card p-6">
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-foreground">{title}</h2>
          {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
        </div>
      </div>
      {children}
    </div>
  );
}

function DeviceIcon({ isCli, isMobile }) {
  if (isCli) return <TerminalIcon className="h-4 w-4 text-muted-foreground" />;
  if (isMobile) return <Smartphone className="h-4 w-4 text-muted-foreground" />;
  return <Laptop className="h-4 w-4 text-muted-foreground" />;
}

/**
 * SessionsCard — the caller's active refresh-token-family "sessions" (one
 * per sign-in / device), not to be confused with SSH/RDP target sessions.
 */
export default function SessionsCard() {
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revokeTarget, setRevokeTarget] = useState(null);
  const [revokeAllConfirm, setRevokeAllConfirm] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [busyAll, setBusyAll] = useState(false);
  const [message, setMessage] = useState('');

  const refresh = useCallback(() => {
    setLoading(true);
    setError('');
    return listAuthSessions()
      .then(setSessions)
      .catch((e) => setError(e?.response?.data?.error?.message || e.message || 'Failed to load sessions'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleRevoke = async () => {
    if (!revokeTarget) return;
    setBusyId(revokeTarget.id);
    try {
      await revokeAuthSession(revokeTarget.id);
      setRevokeTarget(null);
      await refresh();
    } catch (e) {
      setError(e?.response?.data?.error?.message || e.message || 'Failed to revoke session');
    } finally {
      setBusyId(null);
    }
  };

  const handleRevokeAll = async () => {
    setBusyAll(true);
    try {
      const { revoked } = await revokeOtherAuthSessions();
      setRevokeAllConfirm(false);
      setMessage(`Signed out ${revoked ?? 'other'} session(s).`);
      setTimeout(() => setMessage(''), 4000);
      await refresh();
    } catch (e) {
      setError(e?.response?.data?.error?.message || e.message || 'Failed to revoke sessions');
    } finally {
      setBusyAll(false);
    }
  };

  const otherSessionsCount = sessions.filter((s) => !s.current).length;

  return (
    <SectionCard
      title="Active sessions"
      description="Devices and applications currently signed in to your account."
    >
      {error && (
        <div className="mb-3 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}
      {message && (
        <div className="mb-3 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300">
          {message}
        </div>
      )}

      {loading ? (
        <div className="space-y-2">
          <Skeleton className="h-14 rounded-md" />
          <Skeleton className="h-14 rounded-md" />
        </div>
      ) : sessions.length === 0 ? (
        <p className="text-sm text-muted-foreground">No active sessions.</p>
      ) : (
        <div className="divide-y divide-border">
          {sessions.map((s) => {
            const desc = describeSession(s);
            return (
              <div key={s.id} className="flex items-center justify-between gap-4 py-3">
                <div className="flex min-w-0 items-start gap-3">
                  <DeviceIcon isCli={desc.isCli} isMobile={desc.isMobile} />
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 text-sm font-medium text-foreground">
                      <span className="truncate">{desc.label}</span>
                      {s.current && <Badge tone="success">This device</Badge>}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {s.ipAddress || 'Unknown IP'} &middot; Started {formatDateTime(s.createdAt)} &middot; Last
                      active {relativeTime(s.lastUsedAt)}
                    </p>
                  </div>
                </div>
                {!s.current && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setRevokeTarget(s)}
                    disabled={busyId === s.id}
                  >
                    {busyId === s.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Revoke'}
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {otherSessionsCount > 0 && (
        <div className="mt-4 border-t border-border pt-4">
          <Button variant="outline" onClick={() => setRevokeAllConfirm(true)} disabled={busyAll}>
            <LogOut className="mr-2 h-4 w-4" />
            Sign out all other sessions
          </Button>
        </div>
      )}

      <ConfirmDialog
        open={!!revokeTarget}
        title="Revoke session?"
        message={`This will immediately sign out ${revokeTarget ? describeSession(revokeTarget).label : 'this device'}.`}
        confirmLabel="Revoke"
        variant="destructive"
        onConfirm={handleRevoke}
        onCancel={() => setRevokeTarget(null)}
      />
      <ConfirmDialog
        open={revokeAllConfirm}
        title="Sign out all other sessions?"
        message="Every other device and application currently signed in will be signed out. This device stays signed in."
        confirmLabel="Sign out others"
        variant="destructive"
        onConfirm={handleRevokeAll}
        onCancel={() => setRevokeAllConfirm(false)}
      />
    </SectionCard>
  );
}
