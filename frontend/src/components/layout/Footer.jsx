import { Link } from 'react-router-dom';
import { APP_VERSION, GIT_SHA } from '@/version';
import useOrgName from '@/hooks/useOrgName';
import useBackendVersion from '@/hooks/useBackendVersion';
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip';

/**
 * Footer
 *
 * App-wide footer modeled on the VaultHive layout — sits inside the
 * scrollable main, but the AppLayout wraps the Outlet in a
 * `min-h-[calc(100%-3rem)]` spacer so the footer always pins to the
 * bottom of the viewport on short pages and scrolls naturally on long
 * ones.
 */
function Footer() {
  const orgName = useOrgName();
  const backendVersion = useBackendVersion();
  const versionMismatch = backendVersion && backendVersion !== APP_VERSION;
  const tooltipLines = [
    `Frontend v${APP_VERSION}${GIT_SHA ? ` (${GIT_SHA})` : ''}`,
    backendVersion ? `Backend v${backendVersion}` : null,
    versionMismatch
      ? 'Version mismatch — hard-refresh, or the deploy may still be rolling out'
      : null,
  ].filter(Boolean);

  return (
    <footer className="shrink-0 border-t border-border/40 bg-card/50 px-6 py-3">
      <div className="flex flex-col gap-2 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
        <p className="flex items-center gap-1.5">
          &copy; {new Date().getFullYear()} {orgName} &middot;{' '}
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  className={
                    versionMismatch
                      ? 'cursor-default font-medium text-amber-500'
                      : 'cursor-default'
                  }
                >
                  v{APP_VERSION}
                  {versionMismatch ? ' ⚠' : ''}
                </span>
              </TooltipTrigger>
              <TooltipContent side="top" className="whitespace-pre-line">
                {tooltipLines.join('\n')}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </p>
        <div className="flex items-center gap-4">
          <Link to="/legal/privacy" className="hover:text-foreground transition-colors">
            Privacy policy
          </Link>
          <Link to="/legal/terms" className="hover:text-foreground transition-colors">
            Terms &amp; Conditions
          </Link>
          <Link to="/legal/eula" className="hover:text-foreground transition-colors">
            EULA
          </Link>
        </div>
      </div>
    </footer>
  );
}

export default Footer;
