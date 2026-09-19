import { Link, useNavigate } from 'react-router-dom';
import { ChevronRight, LogOut, ShieldCheck, Terminal, Upload } from 'lucide-react';
import BottomSheet from '@/components/mobile/BottomSheet';
import { NavGroup, NavRow, SearchLauncher } from '@/components/mobile/MobileNavList';
import ThemeSegmented from '@/components/layout/ThemeSegmented';
import Avatar from '@/components/ui/Avatar';
import { useAuth } from '@/context/AuthContext';
import { useCommandPalette } from '@/context/CommandPaletteContext';
import { NAV_SECTIONS } from '@/lib/navSections';
import { moreSheetSections } from '@/lib/mobileNav';
import { canAccessRoute } from '@/lib/commands';
import { canSeeAdministration } from '@/lib/adminSections';
import { APP_VERSION } from '@/version';
import { cn } from '@/lib/utils';

// Home is its own tab and Terminals is on Connect; everything else the
// sidebar lists is here.
const SKIP = new Set(['dashboard', 'terminals']);

/** A page tile in the launcher grid. */
function PageTile({ item, active, badge, onGo }) {
  const Icon = item.icon;
  return (
    <Link
      to={item.to}
      onClick={onGo}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'relative flex min-h-[4.5rem] flex-col items-center justify-center gap-1.5 rounded-lg border px-1.5 py-2 text-center text-xs font-medium transition-colors active:bg-accent',
        active
          ? 'border-[hsl(var(--brand)/0.4)] bg-[hsl(var(--brand)/0.1)] text-[hsl(var(--brand))]'
          : 'border-border bg-card text-foreground'
      )}
    >
      <Icon className={cn('h-5 w-5', !active && 'text-muted-foreground')} aria-hidden="true" />
      <span className="line-clamp-2 leading-tight">{item.label}</span>
      {badge > 0 && (
        <span className="absolute right-1.5 top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-500 px-1 text-[9px] font-semibold leading-none text-white">
          {badge > 9 ? '9+' : badge}
        </span>
      )}
    </Link>
  );
}

/**
 * MoreSheet — the phone bottom navigation's "More" tab: search, your
 * account, every other page (the sidebar's groups, filtered by
 * ROUTE_ACCESS), Administration and the rest of the account menu, the theme
 * and sign out. Replaces the top bar's menu button, search and avatar.
 */
function MoreSheet({ open, onClose, pathname, pendingReviews = 0 }) {
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const { openPalette } = useCommandPalette();
  const sections = moreSheetSections(user, NAV_SECTIONS)
    .map((s) => ({ ...s, items: s.items.filter((i) => !SKIP.has(i.id)) }))
    .filter((s) => s.items.length > 0);
  const isActive = (to) => pathname === to || pathname.startsWith(`${to}/`);

  const go = (to) => {
    onClose();
    navigate(to);
  };

  return (
    <BottomSheet open={open} onClose={onClose} title="More" bodyClassName="space-y-5">
      <Link
        to="/profile"
        onClick={onClose}
        className="flex items-center gap-3 rounded-lg border border-border bg-card p-3 transition-colors active:bg-accent"
      >
        <Avatar name={user?.name} email={user?.email} avatarUrl={user?.avatarUrl} size="md" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold text-foreground">{user?.name || 'Your account'}</span>
          <span className="block truncate text-xs text-muted-foreground">{user?.email}</span>
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">Profile</span>
        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/60" aria-hidden="true" />
      </Link>

      <SearchLauncher
        onClick={() => {
          onClose();
          openPalette();
        }}
      />

      {sections.map((section) => (
        <section key={section.label}>
          <h2 className="mb-1.5 px-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            {section.label}
          </h2>
          <div className="grid grid-cols-3 gap-2">
            {section.items.map((item) => (
              <PageTile
                key={item.id}
                item={item}
                active={isActive(item.to)}
                badge={item.id === 'access-requests' ? pendingReviews : 0}
                onGo={onClose}
              />
            ))}
          </div>
        </section>
      ))}

      <NavGroup label="Account">
        {canSeeAdministration(user) && (
          <NavRow icon={ShieldCheck} label="Administration" description="Users, roles, security and integrations" onClick={() => go('/admin')} />
        )}
        {canAccessRoute(user, '/bulk-import') && (
          <NavRow icon={Upload} label="Bulk import" description="Servers and customers from a file" onClick={() => go('/bulk-import')} />
        )}
        <NavRow icon={Terminal} label="Install CLI" description="The shellius terminal client" onClick={() => go('/install-cli')} />
      </NavGroup>

      <div className="rounded-lg border border-border bg-card px-3 py-2.5">
        <ThemeSegmented />
      </div>

      <NavGroup>
        <NavRow
          icon={LogOut}
          label="Sign out"
          destructive
          onClick={() => {
            onClose();
            logout();
          }}
        />
      </NavGroup>

      <p className="flex items-center justify-center gap-3 pb-1 text-[11px] text-muted-foreground">
        <Link to="/legal/privacy" onClick={onClose} className="hover:text-foreground">Privacy</Link>
        <Link to="/legal/terms" onClick={onClose} className="hover:text-foreground">Terms</Link>
        <Link to="/legal/eula" onClick={onClose} className="hover:text-foreground">EULA</Link>
        <span>v{APP_VERSION}</span>
      </p>
    </BottomSheet>
  );
}

export default MoreSheet;
