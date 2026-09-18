import { useEffect, useRef, useState } from 'react';
import { Zap } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from '@/components/ui/tooltip';
import QuickConnectModal from './QuickConnectModal';
import { getQuickConnectSettings } from '@/services/quickConnectService';

/**
 * QuickConnectButton — compact trigger shown in the Topbar and on the
 * Servers page header. Hidden entirely when Quick Connect is disabled org-wide
 * or the caller's role doesn't meet the configured minimum.
 *
 * Keyboard shortcut: "g" then "q" (mirrors the g-chord nav shortcuts in
 * useKeyboardShortcuts, but opens a modal instead of navigating, so it's
 * handled locally rather than in that hook).
 */
function QuickConnectButton({ variant = 'outline', size = 'sm', className }) {
  const [allowed, setAllowed] = useState(false);
  const [open, setOpen] = useState(false);
  const gPressedAt = useRef(null);

  useEffect(() => {
    let cancelled = false;
    getQuickConnectSettings()
      .then((data) => {
        if (!cancelled) setAllowed(!!data?.allowed);
      })
      .catch(() => {
        if (!cancelled) setAllowed(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

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
          setOpen(true);
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [allowed]);

  if (!allowed) return null;

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant={variant} size={size} className={className} onClick={() => setOpen(true)}>
            <Zap className="mr-1.5 h-4 w-4" />
            Quick Connect
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Ad-hoc SSH connection · shortcut: g q</TooltipContent>
      </Tooltip>
      <QuickConnectModal open={open} onClose={() => setOpen(false)} />
    </TooltipProvider>
  );
}

export default QuickConnectButton;
