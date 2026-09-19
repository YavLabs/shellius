import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { APP_VERSION } from '@/version';
import useOrgName from '@/hooks/useOrgName';
import BrandLogo, { BrandLockupStacked } from '@/components/common/BrandLogo';
import { cn } from '@/lib/utils';
import FlowRing from './FlowRing';

// Brand palette (brand/README.txt): Sky #8FB6F5 → Lavender #B9A6F2, with
// the deeper light-background pair #3D63B8 → #6B54C4 for contrast.
const RINGS = [
  { colors: ['#8FB6F5', '#A7AEF4', '#B9A6F2'], seed: 3, dur: 14 },
  { colors: ['#3D63B8', '#8FB6F5', '#B9A6F2'], seed: 11, dur: 18 },
  { colors: ['#B9A6F2', '#8FB6F5', '#6B54C4'], seed: 23, dur: 16 },
  { colors: ['#6B54C4', '#B9A6F2', '#8FB6F5'], seed: 37, dur: 20 },
  { colors: ['#8FB6F5', '#6B54C4', '#B9A6F2'], seed: 51, dur: 15 },
];

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
 * SSO callback, 404, legal). Fey-style: near-black canvas, soft coloured
 * organic rings slowly morphing and drifting around the edges, the form floating without a card (see `.auth-fey`
 * in index.css), and the footer pinned to the bottom.
 *
 *   align   'center' (forms, default) | 'top' (long documents)
 *   footer  optional line above the legal links (e.g. the sign-up prompt)
 *   logo    'corner' (horizontal lockup top left, default) | 'stacked'
 *           (big lockup centred as the heading — sign-in page)
 */
function AuthShell({ children, align = 'center', className, footer, logo = 'corner' }) {
  // A different mix of ring sizes on every visit.
  const rings = useMemo(() => RINGS.map((r) => ({ ...r, scale: 0.65 + Math.random() * 0.7 })), []);
  return (
    <div className={cn('auth-fey relative isolate flex min-h-screen flex-col overflow-hidden', logo === 'stacked' && 'auth-stacked')}>
      <div aria-hidden="true" className="auth-backdrop -z-10">
        <div className="brand-bloom absolute inset-0" />
        {rings.map((r, i) => (
          <FlowRing key={i} className={`auth-ring auth-ring-${i + 1}`} colors={r.colors} seed={r.seed} dur={r.dur} scale={r.scale} />
        ))}
        <div className="auth-aura" />
      </div>
      {logo === 'corner' && (
        <header className="relative flex items-center px-6 pt-6">
          <Link to="/" aria-label="Home" className="transition-opacity hover:opacity-90">
            <BrandLogo size="sm" />
          </Link>
        </header>
      )}
      <main
        className={cn(
          'relative flex flex-1 flex-col items-center px-4 pt-10',
          align === 'center' ? 'justify-center py-10' : 'py-8',
          className
        )}
      >
        {/* Sign-in: stacked lockup centred as the heading (brand: login). */}
        {logo === 'stacked' && <BrandLockupStacked className="mb-5" />}
        {children}
      </main>
      <AuthFooter className="relative">{footer}</AuthFooter>
    </div>
  );
}

export default AuthShell;
