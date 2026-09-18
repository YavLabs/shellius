import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import { useQuickConnect } from '@/context/QuickConnectContext';
import { useCommandPalette } from '@/context/CommandPaletteContext';
import { QUICK_ACTIONS, isQuickActionVisible } from '@/lib/commands';
import { runQuickAction } from '@/lib/runQuickAction';

function ShortcutHint({ hint }) {
  if (!hint) return null;
  return (
    <span className="flex shrink-0 items-center gap-0.5">
      {hint.split(' ').map((key, i) => (
        <kbd
          key={i}
          className="inline-flex h-4 min-w-4 items-center justify-center rounded border border-border bg-muted px-1 font-mono text-[9px] font-medium uppercase text-muted-foreground"
        >
          {key}
        </kbd>
      ))}
    </span>
  );
}

function ActionTile({ action, onRun }) {
  const Icon = action.icon;
  return (
    <button
      type="button"
      onClick={() => onRun(action)}
      className="group flex flex-col items-start gap-2.5 rounded-lg border border-border bg-card p-3 text-left transition-all hover:border-primary/40 hover:bg-accent/30 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="flex w-full items-center justify-between gap-2">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
          <Icon className="h-4 w-4" />
        </div>
        <ShortcutHint hint={action.shortcutHint} />
      </div>
      <p className="text-xs font-medium leading-tight text-foreground">{action.label}</p>
    </button>
  );
}

/**
 * QuickActionsWidget — Dashboard card rendering the same role-gated
 * QUICK_ACTIONS registry (lib/commands.js) as the Topbar Quick Actions menu
 * and command palette, as a grid of compact tiles. Clicking a tile runs the
 * exact same handler (lib/runQuickAction.js) so all three surfaces behave
 * identically.
 */
function QuickActionsWidget() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { allowed: quickConnectAllowed, openQuickConnect } = useQuickConnect();
  const { openPalette } = useCommandPalette();

  const visible = QUICK_ACTIONS.filter((a) => isQuickActionVisible(a, user, quickConnectAllowed));
  const createItems = visible.filter((a) => a.group === 'Create');
  const operateItems = visible.filter((a) => a.group === 'Operate');

  const run = (action) => runQuickAction(action, { navigate, openQuickConnect, openPalette });

  if (visible.length === 0) return null;

  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <div className="mb-4">
        <h2 className="text-sm font-semibold text-foreground">Quick actions</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">Jump straight to common tasks</p>
      </div>

      <div className="space-y-4">
        {createItems.length > 0 && (
          <div>
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Create
            </p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {createItems.map((a) => (
                <ActionTile key={a.id} action={a} onRun={run} />
              ))}
            </div>
          </div>
        )}

        {operateItems.length > 0 && (
          <div>
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Operate
            </p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {operateItems.map((a) => (
                <ActionTile key={a.id} action={a} onRun={run} />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default QuickActionsWidget;
