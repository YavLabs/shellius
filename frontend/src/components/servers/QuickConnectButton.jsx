import { useState, useEffect } from 'react';
import { Terminal, KeyRound, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import QuickConnectModal from './QuickConnectModal';
import { getActiveAccessForServer } from '@/services/accessRequestService';

/**
 * QuickConnectButton
 *
 * Props:
 *   server       — the server row object
 *   currentUser  — auth user from useAuth()
 */
function QuickConnectButton({ server, currentUser }) {
  const [activeRequest, setActiveRequest] = useState(undefined); // undefined = loading
  const [modalOpen, setModalOpen] = useState(false);

  useEffect(() => {
    if (!server?.id) return;
    let cancelled = false;
    let interval = null;

    const fetchActive = () => {
      getActiveAccessForServer(server.id)
        .then((ar) => {
          if (!cancelled) setActiveRequest(ar); // null = no active request
        })
        .catch(() => {
          if (!cancelled) setActiveRequest(null);
        });
    };

    fetchActive();
    // Phase 18C: poll every 60s while the row is mounted so a request that
    // expires mid-session flips the button from "Connect" to "Request Access"
    // without a manual reload.
    interval = setInterval(fetchActive, 60_000);

    return () => {
      cancelled = true;
      if (interval) clearInterval(interval);
    };
  }, [server?.id]);

  const loading = activeRequest === undefined;
  // Phase 18C: defensive double-check. The backend filter should already
  // exclude EXPIRED / DENIED / REVOKED rows (Task 18C backend), but never
  // trust a single layer.
  const hasAccess =
    !!activeRequest &&
    activeRequest.status === 'APPROVED' &&
    activeRequest.expiresAt &&
    new Date(activeRequest.expiresAt) > new Date();

  return (
    <>
      <Button
        size="sm"
        variant={hasAccess ? 'default' : 'outline'}
        className="gap-1.5"
        disabled={loading}
        onClick={(e) => {
          e.stopPropagation();
          setModalOpen(true);
        }}
      >
        {loading ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : hasAccess ? (
          <>
            <Terminal className="h-4 w-4" />
            Connect
          </>
        ) : (
          <>
            <KeyRound className="h-4 w-4" />
            Request Access
          </>
        )}
      </Button>

      {modalOpen && (
        <QuickConnectModal
          open={modalOpen}
          onClose={() => setModalOpen(false)}
          server={server}
          currentUser={currentUser}
          activeRequest={hasAccess ? activeRequest : null}
        />
      )}
    </>
  );
}

export default QuickConnectButton;
