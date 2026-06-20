import { Link } from 'react-router-dom';
import { APP_VERSION } from '@/version';
import useOrgName from '@/hooks/useOrgName';

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
  return (
    <footer className="shrink-0 border-t border-border/40 bg-card/50 px-6 py-3">
      <div className="flex flex-col gap-2 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
        <p>
          &copy; {new Date().getFullYear()} {orgName} &middot; v{APP_VERSION}
        </p>
        <div className="flex items-center gap-4">
          <Link to="/legal/privacy" className="hover:text-foreground transition-colors">
            Privacy Policy
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
