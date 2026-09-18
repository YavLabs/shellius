import { useEffect, useState } from 'react';
import { Copy, Square, PlugZap, X } from 'lucide-react';
import EnvironmentBadge from '@/components/shared/EnvironmentBadge';
import ConfirmDialog from '@/components/shared/ConfirmDialog';
import { listTerminalSessions, closeTerminalSession } from '@/services/terminalService';
import { relativeTime } from '@/utils/time';

/**
 * SessionsPanel — collapsible right sidebar listing every live hub session
 * (including detached ones not open in any tab): Attach, Duplicate, End.
 */
function SessionsPanel({ workspace, onClose }) {
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [endTarget, setEndTarget] = useState(null);

  const load = () => {
    listTerminalSessions()
      .then(setSessions)
      .catch(() => setSessions([]))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
    const id = setInterval(load, 15000);
    return () => clearInterval(id);
  }, []);

  const openTabIds = new Set(workspace.tabs.map((t) => t.sessionId).filter(Boolean));

  const handleAttach = (session) => {
    workspace.attachSession(session.id, {
      label: session.label || session.server?.displayName || session.host,
      env: session.server?.environment,
      host: session.host,
      username: session.username,
    });
  };

  const handleDuplicate = async (session) => {
    const existing = workspace.tabs.find((t) => t.sessionId === session.id);
    if (existing) {
      await workspace.duplicateTab(existing.id);
      return;
    }
    // Attach first (so duplicateTab has a tab to key off), then duplicate.
    const id = workspace.attachSession(session.id, { label: session.label, host: session.host, username: session.username });
    await workspace.duplicateTab(id);
  };

  const handleEnd = async () => {
    if (!endTarget) return;
    try {
      await closeTerminalSession(endTarget.id);
    } finally {
      setEndTarget(null);
      load();
    }
  };

  return (
    <div className="flex h-full w-72 shrink-0 flex-col border-l border-border bg-card">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-border px-3">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Sessions {sessions.length > 0 && `(${sessions.length})`}
        </span>
        <button type="button" onClick={onClose} className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground" aria-label="Close sessions panel">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading && <p className="p-3 text-xs text-muted-foreground">Loading...</p>}
        {!loading && sessions.length === 0 && (
          <p className="p-3 text-xs text-muted-foreground">No live sessions.</p>
        )}
        <ul className="divide-y divide-border">
          {sessions.map((s) => {
            const inTab = openTabIds.has(s.id);
            return (
              <li key={s.id} className="p-2.5 text-xs">
                <div className="mb-1 flex items-center gap-1.5">
                  <span
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${s.state === 'attached' ? 'bg-emerald-500' : 'bg-muted-foreground/60'}`}
                  />
                  <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                    {s.label || s.server?.displayName || s.host}
                  </span>
                  {s.server?.environment && <EnvironmentBadge environment={s.server.environment} />}
                </div>
                <p className="truncate text-muted-foreground">
                  {s.username ? `${s.username}@` : ''}
                  {s.host}
                  {s.port ? `:${s.port}` : ''}
                </p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  {s.state === 'detached' ? 'Detached' : 'Attached'} · started {relativeTime(s.startedAt)}
                  {s.state === 'detached' && s.endsAt && <> · ends {relativeTime(s.endsAt)}</>}
                </p>
                <div className="mt-1.5 flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => handleAttach(s)}
                    disabled={inTab}
                    className="inline-flex h-6 items-center gap-1 rounded border border-border px-1.5 text-[11px] font-medium text-foreground hover:bg-accent disabled:opacity-50"
                  >
                    <PlugZap className="h-3 w-3" /> {inTab ? 'Open' : 'Attach'}
                  </button>
                  {s.canDuplicate !== false && (
                    <button
                      type="button"
                      onClick={() => handleDuplicate(s)}
                      className="inline-flex h-6 items-center gap-1 rounded border border-border px-1.5 text-[11px] font-medium text-foreground hover:bg-accent"
                    >
                      <Copy className="h-3 w-3" /> Duplicate
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setEndTarget(s)}
                    className="inline-flex h-6 items-center gap-1 rounded border border-border px-1.5 text-[11px] font-medium text-destructive hover:bg-destructive/10"
                  >
                    <Square className="h-3 w-3" /> End
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      </div>

      <ConfirmDialog
        open={!!endTarget}
        title="End session"
        message="This immediately closes the SSH connection for everyone attached to it. This can't be undone."
        confirmLabel="End session"
        variant="destructive"
        onConfirm={handleEnd}
        onCancel={() => setEndTarget(null)}
      />
    </div>
  );
}

export default SessionsPanel;
