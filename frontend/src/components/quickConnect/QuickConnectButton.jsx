import { useEffect, useRef } from 'react';
import { Zap } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from '@/components/ui/tooltip';
import { useQuickConnect } from '@/context/QuickConnectContext';

/**
 * QuickConnectButton — compact trigger shown in the Topbar and on the
 * Servers page header. Hidden entirely when Quick Connect is disabled org-wide
 * or the caller's role doesn't meet the configured minimum.
 *
 * The "allowed" check and the modal itself now live in QuickConnectContext
 * (mounted once in AppLayout) so the Quick Actions menu and command palette
 * can open the same modal programmatically via useQuickConnect().
 *
 * Keyboard shortcut: "g" then "q" (mirrors the g-chord nav shortcuts in
 * useKeyboardShortcuts, but opens a modal instead of navigating, so it's
 * handled locally rather than in that hook).
 */
function QuickConnectButton({ variant = 'default', size = 'sm', className }) {
  const { allowed, openQuickConnect } = useQuickConnect();
  const gPressedAt = useRef(null);

  useEffect(() => {
    if (!allowed) return undefined;
    function isInputFocused() {
      const tag = document.activeElement?.tagName?.toLowerCase();
      return tag === 'input' || tag === 'textarea' || tag === 'select' || document.activeElement?.isContentEditable;
    }
    function handleKeyDown(e) {
      if (isInputFocused()) return;
      if (e.key === 'g') {
        gPressedAt.current = Date.now();
        return;
      }
      if (gPressedAt.current !== null) {
        const elapsed = Date.now() - gPressedAt.current;
        gPressedAt.current = null;
        if (elapsed <= 500 && e.key === 'q') {
          e.preventDefault();
          openQuickConnect();
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [allowed, openQuickConnect]);

  if (!allowed) return null;

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant={variant}
            size={size}
            className={className}
            onClick={openQuickConnect}
            aria-label="Quick connect"
          >
            <Zap className="h-4 w-4 sm:mr-1.5" />
            <span className="hidden sm:inline">Quick connect</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Quick connect · Ad-hoc SSH connection · shortcut: g q</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export default QuickConnectButton;
