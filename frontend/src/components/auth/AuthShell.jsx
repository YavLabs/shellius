import { Link } from 'react-router-dom';
import { APP_VERSION } from '@/version';
import useOrgName from '@/hooks/useOrgName';
import { cn } from '@/lib/utils';

const LEGAL_LINKS = [
  { to: '/legal/privacy', label: 'Privacy policy' },
  { to: '/legal/terms', label: 'Terms & Conditions' },
  { to: '/legal/eula', label: 'EULA' },
];

/** Legal footer under the auth card: copyright, version, legal documents. */
export function AuthFooter({ className }) {
  const orgName = useOrgName();
  return (
    <footer className={cn('px-4 py-6 text-xs text-muted-foreground', className)}>
      <nav aria-label="Legal" className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1">
        {LEGAL_LINKS.map((l) => (
          <Link key={l.to} to={l.to} className="transition-colors hover:text-foreground">
            {l.label}
          </Link>
        ))}
      </nav>
      <p className="mt-2 text-center">
        &copy; {new Date().getFullYear()} {orgName} &middot; Shellius v{APP_VERSION}
      </p>
    </footer>
  );
}

/**
 * AuthShell — shared frame for every signed-out / full-screen auth page
 * (login, register, invite, password reset, device, approvals, MFA setup,
 * SSO callback, 404, legal): a faint grid that fades out from the centre,
 * the page's card centred in the free space, and the legal footer below.
 *
 *   align  'center' (cards, default) | 'top' (long documents)
 */
function AuthShell({ children, align = 'center', className }) {
  return (
    <div className="relative flex min-h-screen flex-col overflow-x-hidden bg-background">
      <div aria-hidden="true" className="bg-grid bg-grid-fade pointer-events-none absolute inset-0" />
      <main
        className={cn(
          'relative flex flex-1 flex-col items-center px-4',
          align === 'center' ? 'justify-center py-10' : 'py-8',
          className
        )}
      >
        {children}
      </main>
      <AuthFooter className="relative" />
    </div>
  );
}

export default AuthShell;
