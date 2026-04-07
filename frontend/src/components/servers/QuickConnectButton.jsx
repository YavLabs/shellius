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
    getActiveAccessForServer(server.id)
      .then((ar) => {
        if (!cancelled) setActiveRequest(ar); // null = no active request
      })
      .catch(() => {
        if (!cancelled) setActiveRequest(null);
      });
    return () => {
      cancelled = true;
    };
  }, [server?.id]);

  const loading = activeRequest === undefined;
  const hasAccess = !!activeRequest;

  return (
    <>
      <Button
        size="sm"
        variant={hasAccess ? 'default' : 'outline'}
        className="h-7 gap-1.5 px-2.5 text-xs"
        disabled={loading}
        onClick={(e) => {
          e.stopPropagation();
          setModalOpen(true);
        }}
      >
        {loading ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : hasAccess ? (
          <>
            <Terminal className="h-3.5 w-3.5" />
            Connect
          </>
        ) : (
          <>
            <KeyRound className="h-3.5 w-3.5" />
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
          activeRequest={activeRequest ?? null}
        />
      )}
    </>
  );
}

export default QuickConnectButton;
