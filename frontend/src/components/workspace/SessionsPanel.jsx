import { useEffect, useMemo, useState } from 'react';
import {
  ArrowUpRight,
  BadgeCheck,
  Copy,
  KeyRound,
  LayoutGrid,
  PlugZap,
  Plus,
  RefreshCw,
  Search,
  Square,
  SquareTerminal,
  X,
  Zap,
} from 'lucide-react';
import EnvironmentBadge from '@/components/shared/EnvironmentBadge';
import ConfirmDialog from '@/components/shared/ConfirmDialog';
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip';
import { closeTerminalSession } from '@/services/terminalService';
import { sessionTabMeta } from '@/components/workspace/RunningSessionsList';
import { relativeTime } from '@/utils/time';
import { cn } from '@/lib/utils';

const AUTH = {
  certificate: { icon: BadgeCheck, label: 'Certificate' },
  credential: { icon: KeyRound, label: 'Identity' },
  quick_connect: { icon: Zap, label: 'Quick Connect' },
};

// "in 12 min" / "in 45 s", for deadlines (detach timeout, access expiry).
function untilText(date) {
  const ms = new Date(date).getTime() - Date.now();
  if (!Number.isFinite(ms)) return '';
  if (ms <= 0) return 'now';
  const min = Math.round(ms / 60000);
  if (min < 1) return `in ${Math.max(1, Math.round(ms / 1000))} s`;
  if (min < 60) return `in ${min} min`;
  const h = Math.floor(min / 60);
  return `in ${h} h ${min % 60} min`;
}

function IconAction({ label, onClick, danger = false, children }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          onClick={(e) => {
            e.stopPropagation();
            onClick();
          }}
          className={cn(
            'flex h-6 w-6 items-center justify-center rounded text-muted-foreground',
            danger ? 'hover:bg-destructive/10 hover:text-destructive' : 'hover:bg-accent hover:text-foreground'
          )}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

function SessionRow({ session, place, onOpen, onDuplicate, onEnd }) {
  const auth = AUTH[session.authMethod] || AUTH.certificate;
  const AuthIcon = auth.icon;
  const name = session.label || session.server?.displayName || session.host;
  const detached = session.state === 'detached';
  const deadline =
    session.endsAt &&
    (detached ? `closes ${untilText(session.endsAt)}` : session.accessRequestId ? `access ends ${untilText(session.endsAt)}` : null);

  return (
    <li>
      <div
        role="button"
        tabIndex={0}
        onClick={onOpen}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onOpen();
          }
        }}
        className="group relative flex cursor-pointer gap-2.5 px-3 py-2.5 outline-none hover:bg-accent/50 focus-visible:bg-accent/50"
        title={place ? `Open (${place.label})` : 'Attach in a new tab'}
      >
        <span
          className={cn(
            'mt-1.5 h-2 w-2 shrink-0 rounded-full',
            place ? 'bg-emerald-500' : detached ? 'bg-muted-foreground/50' : 'bg-sky-500'
          )}
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[13px] font-medium text-foreground">{name}</span>
            {session.server?.environment && <EnvironmentBadge environment={session.server.environment} />}
          </div>
          <p className="truncate font-mono text-[11px] text-muted-foreground">
            {session.username ? `${session.username}@` : ''}
            {session.host}
            {session.port && session.port !== 22 ? `:${session.port}` : ''}
          </p>
          <p className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <AuthIcon className="h-3 w-3" aria-hidden="true" />
              {auth.label}
            </span>
            <span aria-hidden="true">·</span>
            <span>started {relativeTime(session.startedAt)}</span>
            {deadline && (
              <>
                <span aria-hidden="true">·</span>
                <span className={detached ? 'text-amber-600 dark:text-amber-400' : ''}>{deadline}</span>
              </>
            )}
          </p>
          {place && (
            <p className="mt-1 inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
              {place.workspace ? (
                <LayoutGrid className="h-3 w-3" aria-hidden="true" />
              ) : (
                <SquareTerminal className="h-3 w-3" aria-hidden="true" />
              )}
              {place.label}
            </p>
          )}
        </div>

        {/* Hover actions */}
        <div className="flex shrink-0 items-start gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
          <IconAction label={place ? 'Open' : 'Attach'} onClick={onOpen}>
            {place ? <ArrowUpRight className="h-3.5 w-3.5" /> : <PlugZap className="h-3.5 w-3.5" />}
          </IconAction>
          {session.canDuplicate !== false && (
            <IconAction label="Duplicate (new session, same access)" onClick={onDuplicate}>
              <Copy className="h-3.5 w-3.5" />
            </IconAction>
          )}
          <IconAction label="End session" onClick={onEnd} danger>
            <Square className="h-3.5 w-3.5" />
          </IconAction>
        </div>
      </div>
    </li>
  );
}

function Section({ title, count, action, children }) {
  return (
    <section>
      <div className="sticky top-0 z-[1] flex items-center justify-between border-b border-border bg-card/95 px-3 py-1.5 backdrop-blur">
        <span className="text-[11px] font-medium text-muted-foreground">
          {title} <span className="tabular-nums text-muted-foreground/70">{count}</span>
        </span>
        {action}
      </div>
      <ul className="divide-y divide-border/60">{children}</ul>
    </section>
  );
}

/**
 * SessionsPanel: right-hand panel with every live session you own.
 *   Open in tabs            sessions shown in a tab or Workspace; click to jump there
 *   Running in background   detached (tab closed, reload, idle) or open in another
 *                           window; click to attach, or Attach all
 * Each row shows the target, auth method, age and deadline (detach timeout
 * or access expiry). Hover actions: Open/Attach, Duplicate, End (confirmed).
 */
function SessionsPanel({ workspace, onClose, onNewConnection }) {
  const { liveSessions, refreshLiveSessions, tabs, groups } = workspace;
  const [endTarget, setEndTarget] = useState(null);
  const [query, setQuery] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    refreshLiveSessions();
  }, [refreshLiveSessions]);

  const refresh = async () => {
    setRefreshing(true);
    refreshLiveSessions();
    setTimeout(() => setRefreshing(false), 500);
  };

  // sessionId → { label, workspace } for sessions open here ("Open in a tab" or the Workspace name).
  const placeOf = useMemo(() => {
    const map = new Map();
    for (const t of tabs) {
      if (!t.sessionId) continue;
      const g = (groups || []).find((grp) => grp.panes.filter(Boolean).length >= 2 && grp.panes.includes(t.id));
      map.set(t.sessionId, g ? { label: g.name || 'Workspace', workspace: true } : { label: 'Open in a tab', workspace: false });
    }
    return map;
  }, [tabs, groups]);

  const q = query.trim().toLowerCase();
  const visible = (liveSessions || []).filter(
    (s) =>
      !q ||
      [s.label, s.host, s.username, s.server?.displayName, s.server?.hostname]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q))
  );
  const open = visible.filter((s) => placeOf.has(s.id));
  const background = visible.filter((s) => !placeOf.has(s.id));

  const openOrAttach = (session) => workspace.attachSession(session.id, sessionTabMeta(session));

  const duplicate = async (session) => {
    const existing = tabs.find((t) => t.sessionId === session.id);
    const id = existing ? existing.id : workspace.attachSession(session.id, { ...sessionTabMeta(session), focus: false });
    await workspace.duplicateTab(id);
  };

  const attachAll = () => {
    const ordered = [...background].reverse();
    ordered.forEach((s, i) => workspace.attachSession(s.id, { ...sessionTabMeta(s), focus: i === ordered.length - 1 }));
  };

  const confirmEnd = async () => {
    if (!endTarget) return;
    try {
      await closeTerminalSession(endTarget.id);
    } finally {
      setEndTarget(null);
      refreshLiveSessions();
    }
  };

  const total = (liveSessions || []).length;

  return (
    <TooltipProvider delayDuration={300}>
      <aside className="flex h-full w-80 shrink-0 flex-col border-l border-border bg-card" aria-label="Sessions">
        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
          <span className="text-sm font-medium text-foreground">Sessions</span>
          {total > 0 && (
            <span className="rounded-full bg-muted px-1.5 text-[11px] font-medium tabular-nums text-muted-foreground">{total}</span>
          )}
          <div className="ml-auto flex items-center gap-0.5">
            <IconAction label="Refresh" onClick={refresh}>
              <RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} />
            </IconAction>
            <IconAction label="Close panel" onClick={onClose}>
              <X className="h-3.5 w-3.5" />
            </IconAction>
          </div>
        </div>

        {total > 5 && (
          <div className="shrink-0 border-b border-border p-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Filter sessions…"
                className="h-7 w-full rounded-md border border-border bg-background pl-7 pr-2 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </div>
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto">
          {total === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
              <SquareTerminal className="h-8 w-8 text-muted-foreground/40" aria-hidden="true" />
              <p className="text-sm font-medium text-foreground">No running sessions</p>
              <p className="text-xs text-muted-foreground">Sessions you open keep running here when you close their tab.</p>
              {onNewConnection && (
                <button
                  type="button"
                  onClick={onNewConnection}
                  className="mt-1 inline-flex h-7 items-center gap-1 rounded-md border border-border px-2.5 text-xs font-medium text-foreground hover:bg-accent"
                >
                  <Plus className="h-3.5 w-3.5" /> New connection
                </button>
              )}
            </div>
          ) : visible.length === 0 ? (
            <p className="p-4 text-center text-xs text-muted-foreground">No sessions match “{query}”.</p>
          ) : (
            <>
              {background.length > 0 && (
                <Section
                  title="Running in background"
                  count={background.length}
                  action={
                    background.length > 1 && (
                      <button type="button" onClick={attachAll} className="text-[11px] font-medium text-primary hover:underline">
                        Attach all
                      </button>
                    )
                  }
                >
                  {background.map((s) => (
                    <SessionRow
                      key={s.id}
                      session={s}
                      place={null}
                      onOpen={() => openOrAttach(s)}
                      onDuplicate={() => duplicate(s)}
                      onEnd={() => setEndTarget(s)}
                    />
                  ))}
                </Section>
              )}
              {open.length > 0 && (
                <Section title="Open in tabs" count={open.length}>
                  {open.map((s) => (
                    <SessionRow
                      key={s.id}
                      session={s}
                      place={placeOf.get(s.id)}
                      onOpen={() => openOrAttach(s)}
                      onDuplicate={() => duplicate(s)}
                      onEnd={() => setEndTarget(s)}
                    />
                  ))}
                </Section>
              )}
            </>
          )}
        </div>

        <ConfirmDialog
          open={!!endTarget}
          title="End session"
          message={`This immediately closes the SSH connection to ${endTarget?.label || endTarget?.host || 'this host'} for everyone attached to it. This can't be undone.`}
          confirmLabel="End session"
          variant="destructive"
          onConfirm={confirmEnd}
          onCancel={() => setEndTarget(null)}
        />
      </aside>
    </TooltipProvider>
  );
}

export default SessionsPanel;
