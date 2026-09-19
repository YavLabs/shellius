import { useNavigate } from 'react-router-dom';
import { Command, Keyboard, Search } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import { useQuickConnect } from '@/context/QuickConnectContext';
import { useCommandPalette } from '@/context/CommandPaletteContext';
import { QUICK_ACTIONS, isQuickActionVisible } from '@/lib/commands';
import { runQuickAction } from '@/lib/runQuickAction';
import { cn } from '@/lib/utils';

// The two things people do most get a prominent tile each; the rest are
// compact rows. Palette/shortcuts live in the footer instead of the grid.
const FEATURED = {
  'quick-connect': { hint: 'Connect to any host', tone: 'bg-amber-500/15 text-amber-600 dark:text-amber-400' },
  'new-access-request': { hint: 'Get time-limited access', tone: 'bg-primary/15 text-primary' },
};
const FOOTER_IDS = new Set(['command-palette', 'shortcuts-help']);

function Keys({ hint, className = '' }) {
  if (!hint) return null;
  return (
    <span className={cn('flex shrink-0 items-center gap-0.5', className)} aria-label={`Shortcut ${hint}`}>
      {hint.split(' ').map((key, i) => (
        <kbd
          key={i}
          className="inline-flex h-4 min-w-4 items-center justify-center rounded border border-border bg-background px-1 font-mono text-[9px] font-medium uppercase text-muted-foreground"
        >
          {key}
        </kbd>
      ))}
    </span>
  );
}

function FeaturedTile({ action, onRun }) {
  const Icon = action.icon;
  const meta = FEATURED[action.id];
  return (
    <button
      type="button"
      onClick={() => onRun(action)}
      className="group flex min-w-0 items-center gap-3 rounded-lg border border-border bg-background/40 p-3 text-left transition-colors hover:border-primary/40 hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-md', meta.tone)}>
        <Icon className="h-4 w-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground">{action.label}</span>
        <span className="block truncate text-[11px] text-muted-foreground">{meta.hint}</span>
      </span>
    </button>
  );
}

function ActionRow({ action, onRun }) {
  const Icon = action.icon;
  return (
    <button
      type="button"
      onClick={() => onRun(action)}
      title={action.label}
      className="group flex min-w-0 items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
    >
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-muted text-muted-foreground transition-colors group-hover:bg-primary/15 group-hover:text-primary">
        <Icon className="h-3.5 w-3.5" />
      </span>
      <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">{action.label}</span>
      <Keys hint={action.shortcutHint} className="opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
    </button>
  );
}

function Group({ title, actions, onRun }) {
  if (actions.length === 0) return null;
  return (
    <div>
      <p className="mb-1 px-2 text-[11px] font-medium text-muted-foreground">{title}</p>
      {/* Two columns when the card spans the page (small screens); one when it's the narrow dashboard column. */}
      <div className="grid grid-cols-1 gap-x-1 sm:grid-cols-2 lg:grid-cols-1">
        {actions.map((a) => (
          <ActionRow key={a.id} action={a} onRun={onRun} />
        ))}
      </div>
    </div>
  );
}

/**
 * QuickActionsWidget — dashboard card over the same role-gated QUICK_ACTIONS
 * registry (lib/commands.js) as the Topbar menu and command palette, run
 * through the same handler (lib/runQuickAction.js), so all three behave
 * identically.
 *
 * Layout: the two most common actions (Quick connect, New access request) as
 * prominent tiles; everything else as compact two-column rows grouped into
 * Create / Operate, with keyboard shortcuts revealed on hover; the command
 * palette and shortcut list in the footer.
 */
function QuickActionsWidget() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { allowed: quickConnectAllowed, openQuickConnect } = useQuickConnect();
  const { openPalette } = useCommandPalette();

  const visible = QUICK_ACTIONS.filter((a) => isQuickActionVisible(a, user, quickConnectAllowed));
  if (visible.length === 0) return null;

  const run = (action) => runQuickAction(action, { navigate, openQuickConnect, openPalette });
  const featured = Object.keys(FEATURED)
    .map((id) => visible.find((a) => a.id === id))
    .filter(Boolean);
  const rest = visible.filter((a) => !FEATURED[a.id] && !FOOTER_IDS.has(a.id));
  const byId = (id) => visible.find((a) => a.id === id);

  return (
    <div className="flex h-full flex-col rounded-lg border border-border bg-card p-5">
      <div className="mb-3 flex items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Quick actions</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">Common tasks, one click away</p>
        </div>
        <button
          type="button"
          onClick={() => openPalette()}
          className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label="Search all commands"
        >
          <Search className="h-3.5 w-3.5" />
          <kbd className="font-mono text-[10px]">Ctrl K</kbd>
        </button>
      </div>

      {featured.length > 0 && (
        <div className={cn('mb-4 grid gap-2', featured.length > 1 ? 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-1' : 'grid-cols-1')}>
          {featured.map((a) => (
            <FeaturedTile key={a.id} action={a} onRun={run} />
          ))}
        </div>
      )}

      <div className="-mx-2 flex-1 space-y-3">
        <Group title="Create" actions={rest.filter((a) => a.group === 'Create')} onRun={run} />
        <Group title="Operate" actions={rest.filter((a) => a.group === 'Operate')} onRun={run} />
      </div>

      <div className="mt-4 flex items-center gap-3 border-t border-border pt-3 text-[11px] text-muted-foreground">
        {byId('command-palette') && (
          <button type="button" onClick={() => run(byId('command-palette'))} className="inline-flex items-center gap-1 hover:text-foreground">
            <Command className="h-3 w-3" /> Command palette
          </button>
        )}
        {byId('shortcuts-help') && (
          <button type="button" onClick={() => run(byId('shortcuts-help'))} className="inline-flex items-center gap-1 hover:text-foreground">
            <Keyboard className="h-3 w-3" /> Keyboard shortcuts <Keys hint="?" />
          </button>
        )}
      </div>
    </div>
  );
}

export default QuickActionsWidget;
