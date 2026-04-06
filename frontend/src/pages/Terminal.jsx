import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Monitor, Server, User } from 'lucide-react';
import WebTerminal from '@/components/terminal/WebTerminal';
import RdpTerminal from '@/components/terminal/RdpTerminal';
import EnvironmentBadge from '@/components/shared/EnvironmentBadge';
import { getAccessRequest } from '@/services/accessRequestService';

function Terminal() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const requestId = searchParams.get('requestId');

  const [request, setRequest] = useState(null);
  const [loadingRequest, setLoadingRequest] = useState(true);

  useEffect(() => {
    if (!requestId) {
      setLoadingRequest(false);
      return;
    }
    setLoadingRequest(true);
    getAccessRequest(requestId)
      .then((resp) => {
        setRequest(resp.data || resp);
      })
      .catch(() => {
        // Non-fatal — still attempt to render the terminal
      })
      .finally(() => setLoadingRequest(false));
  }, [requestId]);

  const handleClose = () => {
    navigate('/access-requests');
  };

  if (!requestId) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center space-y-2">
          <p className="text-sm text-muted-foreground">No request ID provided.</p>
          <button
            onClick={() => navigate('/access-requests')}
            className="text-xs text-primary hover:underline"
          >
            Go to Access Requests
          </button>
        </div>
      </div>
    );
  }

  const protocol = request?.protocol || 'SSH';
  const isRdp = protocol === 'RDP';

  const serverName =
    request?.server?.hostname || request?.server?.name || request?.serverId || 'Unknown server';
  const userName =
    request?.requester?.name || request?.requester?.email || request?.requesterId || '';
  const environment = request?.server?.environment;

  const ProtocolIcon = isRdp ? Monitor : Server;

  return (
    <div className="flex flex-col h-full p-4 gap-3">
      {/* Header */}
      <div className="flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3">
          <button
            onClick={handleClose}
            className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeft className="h-4 w-4" />
            Back
          </button>
          <span className="text-border">|</span>
          {loadingRequest ? (
            <div className="h-5 w-48 animate-pulse rounded bg-muted" />
          ) : (
            <div className="flex items-center gap-2">
              <ProtocolIcon className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-semibold text-foreground">{serverName}</span>
              {environment && <EnvironmentBadge environment={environment} />}
              {isRdp && (
                <span className="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20">
                  RDP
                </span>
              )}
              {userName && (
                <>
                  <span className="text-border">·</span>
                  <User className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="text-sm text-muted-foreground">{userName}</span>
                </>
              )}
            </div>
          )}
        </div>
        <button
          onClick={handleClose}
          className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-accent transition-colors"
        >
          Close Session
        </button>
      </div>

      {/* Terminal — fills remaining height */}
      <div className="flex-1 min-h-0">
        {isRdp ? (
          <RdpTerminal requestId={requestId} />
        ) : (
          <WebTerminal requestId={requestId} />
        )}
      </div>
    </div>
  );
}

export default Terminal;
