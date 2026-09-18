import { useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from '@/components/ui/tooltip';
import { useAuth } from '@/context/AuthContext';
import { useQuickConnect } from '@/context/QuickConnectContext';
import { useCommandPalette } from '@/context/CommandPaletteContext';
import { QUICK_ACTIONS, isQuickActionVisible } from '@/lib/commands';

const isMac =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPod|iPad/i.test(navigator.platform || navigator.userAgent || '');
const MOD_LABEL = isMac ? '⌘' : 'Ctrl';

/**
 * QuickActionsMenu — Topbar dropdown grouping the same list of actions as
 * the command palette (lib/commands.js is the single source of truth).
 * Hidden entirely if the current user can't do anything on the list.
 */
function QuickActionsMenu() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { allowed: quickConnectAllowed, openQuickConnect } = useQuickConnect();
  const { openPalette } = useCommandPalette();

  const visible = QUICK_ACTIONS.filter((a) => isQuickActionVisible(a, user, quickConnectAllowed));
  const createItems = visible.filter((a) => a.group === 'Create');
  const operateItems = visible.filter((a) => a.group === 'Operate');

  if (visible.length === 0) return null;

  const run = (action) => {
    if (action.action === 'quick-connect') {
      openQuickConnect();
      return;
    }
    if (action.action === 'command-palette') {
      openPalette();
      return;
    }
    if (action.action === 'shortcuts-help') {
      window.dispatchEvent(new CustomEvent('shellius:open-shortcuts'));
      return;
    }
    if (action.href) navigate(action.href);
  };

  return (
    <DropdownMenu>
      <TooltipProvider delayDuration={300}>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-9 w-9 text-muted-foreground hover:text-foreground"
                aria-label="Quick actions"
              >
                <Plus className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">Quick actions</TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <DropdownMenuContent align="end" className="w-64">
        {createItems.length > 0 && (
          <>
            <DropdownMenuLabel>Create</DropdownMenuLabel>
            {createItems.map((a) => {
              const Icon = a.icon;
              return (
                <DropdownMenuItem key={a.id} onSelect={() => run(a)}>
                  <Icon className="mr-2 h-4 w-4" />
                  {a.label}
                  {a.shortcutHint && <DropdownMenuShortcut>{a.shortcutHint}</DropdownMenuShortcut>}
                </DropdownMenuItem>
              );
            })}
          </>
        )}

        {createItems.length > 0 && operateItems.length > 0 && <DropdownMenuSeparator />}

        {operateItems.length > 0 && (
          <>
            <DropdownMenuLabel>Operate</DropdownMenuLabel>
            {operateItems.map((a) => {
              const Icon = a.icon;
              const shortcut = a.shortcutHint || (a.id === 'command-palette' ? `${MOD_LABEL}K` : null);
              return (
                <DropdownMenuItem key={a.id} onSelect={() => run(a)}>
                  <Icon className="mr-2 h-4 w-4" />
                  {a.label}
                  {shortcut && <DropdownMenuShortcut>{shortcut}</DropdownMenuShortcut>}
                </DropdownMenuItem>
              );
            })}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export default QuickActionsMenu;
