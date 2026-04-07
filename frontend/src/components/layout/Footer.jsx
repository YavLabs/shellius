import { Link } from 'react-router-dom';
import { APP_VERSION } from '@/version';

/**
 * Footer
 *
 * Slim app-wide footer rendered under the main outlet on every
 * authenticated page. Surfaces the running app version plus links to
 * the legal documents and the project repo.
 */
function Footer() {
  return (
    <footer className="border-t border-border/60 bg-background/60 px-6 py-3 text-xs text-muted-foreground">
      <div className="flex flex-col items-center justify-between gap-2 sm:flex-row">
        <div className="flex items-center gap-2">
          <span className="font-medium text-foreground/80">Shellius</span>
          <span className="rounded border border-border/60 bg-muted/40 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide">
            v{APP_VERSION}
          </span>
        </div>
        <nav className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <Link to="/legal/privacy" className="hover:text-foreground transition-colors">
            Privacy
          </Link>
          <Link to="/legal/terms" className="hover:text-foreground transition-colors">
            Terms
          </Link>
          <Link to="/legal/eula" className="hover:text-foreground transition-colors">
            EULA
          </Link>
          <a
            href="https://github.com/vaidyayash8/shellius"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-foreground transition-colors"
          >
            GitHub
          </a>
        </nav>
        <div className="text-[11px] text-muted-foreground/80">
          &copy; {new Date().getFullYear()} Shellius. Licensed under AGPL-3.0.
        </div>
      </div>
    </footer>
  );
}

export default Footer;
