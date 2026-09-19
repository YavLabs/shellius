import { Link } from 'react-router-dom';
import { APP_VERSION } from '@/version';
import useOrgName from '@/hooks/useOrgName';
import { BrandMark } from '@/components/common/BrandLogo';
import { cn } from '@/lib/utils';

const LEGAL_LINKS = [
  { to: '/legal/privacy', label: 'Privacy policy' },
  { to: '/legal/terms', label: 'Terms & Conditions' },
  { to: '/legal/eula', label: 'EULA' },
];

/**
 * Footer under the auth form: an optional line (e.g. "Don't have an account
 * yet? Sign up."), a hairline, then legal links, copyright and version.
 */
export function AuthFooter({ className, children }) {
  const orgName = useOrgName();
  return (
    <footer className={cn('px-4 pb-6 text-xs text-muted-foreground', className)}>
      <div className="mx-auto max-w-md">
        {children && <div className="pb-5 text-center text-sm">{children}</div>}
        <div className="hairline-fade" />
        <nav aria-label="Legal" className="mt-4 flex flex-wrap items-center justify-center gap-x-4 gap-y-1">
          {LEGAL_LINKS.map((l) => (
            <Link key={l.to} to={l.to} className="transition-colors hover:text-foreground">
              {l.label}
            </Link>
          ))}
        </nav>
        <p className="mt-2 text-center text-muted-foreground/70">
          &copy; {new Date().getFullYear()} {orgName} &middot; Shellius v{APP_VERSION}
        </p>
      </div>
    </footer>
  );
}

/**
 * AuthShell — shared frame for every signed-out / full-screen auth page
 * (login, register, invite, password reset, device, approvals, MFA setup,
 * SSO callback, 404, legal). Fey-style: near-black canvas, a soft coloured
 * aura behind the form, the form floating without a card (see `.auth-fey`
 * in index.css), and the footer pinned to the bottom.
 *
 *   align   'center' (forms, default) | 'top' (long documents)
 *   footer  optional line above the legal links (e.g. the sign-up prompt)
 */
function AuthShell({ children, align = 'center', className, footer }) {
  return (
    <div className="auth-fey relative isolate flex min-h-screen flex-col overflow-hidden">
      <div aria-hidden="true" className="auth-aura -z-10" />
      <header className="relative flex items-center px-5 pt-5">
        <Link to="/" aria-label="Home" className="opacity-80 transition-opacity hover:opacity-100">
          <BrandMark size="sm" />
        </Link>
      </header>
      <main
        className={cn(
          'relative flex flex-1 flex-col items-center px-4',
          align === 'center' ? 'justify-center py-10' : 'py-8',
          className
        )}
      >
        {children}
      </main>
      <AuthFooter className="relative">{footer}</AuthFooter>
    </div>
  );
}

export default AuthShell;
