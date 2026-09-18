import EnvironmentBadge from '@/components/shared/EnvironmentBadge';
import { useTerminalWorkspace } from '@/context/TerminalWorkspaceContext';
import { relativeTime } from '@/utils/time';

export function sessionTabMeta(session) {
  return {
    label: session.label || session.server?.displayName || session.host,
    env: session.server?.environment,
    host: session.host,
    username: session.username,
  };
}

/**
 * Live sessions that are not open in any tab (detached after closing a tab,
 * a reload, or another browser window), with Attach per row and Attach all.
 * Used by the empty workspace and the "+" New connection dialog, so
 * re-attaching a second or third session never needs the Sessions panel.
 *
 * `onAttached` (optional) runs after an attach, e.g. to close a dialog.
 */
function RunningSessionsList({ onAttached, className = '' }) {
  const { tabs, liveSessions, attachSession } = useTerminalWorkspace();
  const openIds = new Set(tabs.map((t) => t.sessionId).filter(Boolean));
  const detached = liveSessions.filter((s) => !openIds.has(s.id));
  if (detached.length === 0) return null;

  const attach = (session, { focus = true } = {}) => attachSession(session.id, { ...sessionTabMeta(session), focus });

  const attachAll = () => {
    // Oldest first so the tab bar keeps start order; the last one is shown.
    const ordered = [...detached].reverse();
    ordered.forEach((s, i) => attach(s, { focus: i === ordered.length - 1 }));
    onAttached?.();
  };

  return (
    <div className={className}>
      <div className="mb-1.5 flex items-center justify-between">
        <p className="text-xs font-medium text-muted-foreground">
          Running sessions <span className="text-muted-foreground/70">({detached.length})</span>
        </p>
        {detached.length > 1 && (
          <button type="button" onClick={attachAll} className="text-[11px] font-medium text-primary hover:underline">
            Attach all
          </button>
        )}
      </div>
      <ul className="divide-y divide-border rounded-md border border-border bg-card">
        {detached.map((session) => (
          <li key={session.id} className="flex items-center gap-3 px-3 py-2 text-left">
            <span
              className={`h-2 w-2 shrink-0 rounded-full ${session.state === 'attached' ? 'bg-emerald-500' : 'bg-muted-foreground/50'}`}
              aria-hidden="true"
            />
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5">
                <span className="truncate text-sm text-foreground">{session.label || session.server?.displayName || session.host}</span>
                {session.server?.environment && <EnvironmentBadge environment={session.server.environment} />}
              </span>
              <span className="block truncate font-mono text-[11px] text-muted-foreground">
                {session.username}@{session.host}
                {session.state === 'detached'
                  ? ` · detached${session.endsAt ? `, closes ${relativeTime(session.endsAt)}` : ''}`
                  : ' · open in another window'}
              </span>
            </span>
            <button
              type="button"
              onClick={() => {
                attach(session);
                onAttached?.();
              }}
              className="inline-flex h-7 shrink-0 items-center rounded-md border border-primary/40 bg-primary/10 px-2.5 text-xs font-medium text-primary hover:bg-primary/20"
            >
              Attach
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default RunningSessionsList;
