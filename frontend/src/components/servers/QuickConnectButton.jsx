import { useState, useEffect, useCallback } from 'react';
import { Terminal, KeyRound, Loader2, Clock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import ConnectModal from './ConnectModal';
import RequestForm from '@/components/access-requests/RequestForm';
import { getAccessIntent } from '@/services/accessRequestService';
import { isServerOnboarded } from '@/lib/serverStatus';

/**
 * QuickConnectButton
 *
 * Dispatches between three states:
 *   - loading         → spinner
 *   - hasActiveAccess → "Connect" → opens ConnectModal with principal picker
 *   - hasPendingReq   → "Request Pending" (disabled, tooltip)
 *   - else            → "Request Access" → opens RequestForm with the
 *                       current server pre-selected (SAME flow as the
 *                       /access-requests page "New Request" button)
 *
 * Props:
 *   server       — the server row object
 *   currentUser  — auth user from useAuth()
 */
function QuickConnectButton({ server, currentUser }) {
  const [intent, setIntent] = useState(undefined); // undefined = loading, null = error
  const [connectOpen, setConnectOpen] = useState(false);
  const [requestOpen, setRequestOpen] = useState(false);

  const fetchIntent = useCallback(() => {
    if (!server?.id) return;
    getAccessIntent(server.id)
      .then((data) => setIntent(data))
      .catch(() => setIntent(null));
  }, [server?.id]);

  useEffect(() => {
    let cancelled = false;
    setIntent(undefined);
    fetchIntent();
    // Phase 18C: poll every 60s while the row is mounted so a request
    // that expires mid-session flips the button automatically.
    const id = setInterval(() => {
      if (!cancelled) fetchIntent();
    }, 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [fetchIntent]);

  const loading = intent === undefined;
  const onboarded = isServerOnboarded(server);
  const hasAccess = !!intent?.hasActiveAccess;
  const hasPending = !!intent?.hasPendingRequest;

  const handleClick = (e) => {
    e.stopPropagation();
    if (!onboarded) return;
    // Always re-check right before opening — covers the "second browser
    // tab approved my AR 10 seconds ago" edge case.
    fetchIntent();
    if (hasAccess) {
      setConnectOpen(true);
    } else if (hasPending) {
      // no-op; button is disabled
    } else {
      setRequestOpen(true);
    }
  };

  const variant = hasAccess ? 'default' : hasPending ? 'ghost' : 'outline';
  const title = !onboarded
    ? 'This server has not been onboarded yet'
    : hasPending
      ? 'An access request is pending manager approval'
      : undefined;

  return (
    <>
      <Button
        size="sm"
        variant={!onboarded ? 'ghost' : variant}
        className="gap-1.5"
        disabled={loading || hasPending || !onboarded}
        onClick={handleClick}
        title={title}
      >
        {loading ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : !onboarded ? (
          <>
            <KeyRound className="h-4 w-4" />
            Not onboarded
          </>
        ) : hasAccess ? (
          <>
            <Terminal className="h-4 w-4" />
            Connect
          </>
        ) : hasPending ? (
          <>
            <Clock className="h-4 w-4" />
            Request Pending
          </>
        ) : (
          <>
            <KeyRound className="h-4 w-4" />
            Request Access
          </>
        )}
      </Button>

      {connectOpen && intent?.hasActiveAccess && (
        <ConnectModal
          open={connectOpen}
          onClose={() => {
            setConnectOpen(false);
            fetchIntent();
          }}
          server={server}
          intent={intent}
          currentUser={currentUser}
        />
      )}

      {requestOpen && (
        <RequestForm
          open={requestOpen}
          onClose={() => setRequestOpen(false)}
          onSuccess={() => {
            setRequestOpen(false);
            fetchIntent();
          }}
          initialServerId={server?.id}
        />
      )}
    </>
  );
}

export default QuickConnectButton;
