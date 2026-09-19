import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  User as UserIcon,
  ShieldCheck,
  Upload,
  Terminal,
  Keyboard,
  LogOut,
} from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import Avatar from '@/components/ui/Avatar';
import { canAccessRoute } from '@/lib/commands';
import { canSeeAdministration } from '@/lib/adminSections';

/**
 * UserMenu — the shared dropdown that opens from the topbar avatar
 * AND from the sidebar user section. Single source of truth so the
 * two surfaces stay in sync.
 *
 * Props:
 *   trigger        — render-prop function ({ open, onClick }) => ReactNode.
 *                    Returns the clickable element (avatar pill, sidebar
 *                    user row, etc.). The function receives the current
 *                    open state and the click handler so the trigger can
 *                    style itself differently when active.
 *   align          — "right" (default, topbar) | "left" (sidebar). Controls
 *                    which edge of the trigger the dropdown anchors to.
 *   verticalAlign  — "below" (default, topbar) | "above" (sidebar opens
 *                    upward because the user section is at the bottom).
 *
 * Items always shown:
 *   - User identity header (name + email)
 *   - Profile       → /profile
 *   - Administration → /admin      (only when at least one section is visible)
 *   - Bulk import   → /bulk-import  (import.run)
 *   - Install CLI   → /install-cli
 *   - Keyboard shortcuts → opens the ShortcutsDialog
 *   - Sign out (destructive)
 *
 * Theme selection lives in the standalone ThemeMenu (topbar), not here.
 */
function UserMenu({ trigger, align = 'right', verticalAlign = 'below' }) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef(null);
  const navigate = useNavigate();
  const { user, logout } = useAuth();

  // Close on outside click. We use a ref + mousedown listener instead of a
  // full-screen overlay because the sidebar version of this menu must NOT
  // block clicks on the surrounding sidebar nav items.
  useEffect(() => {
    if (!open) return undefined;
    const handler = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Close on Escape.
  useEffect(() => {
    if (!open) return undefined;
    const handler = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open]);

  const close = () => setOpen(false);
  const go = (path) => {
    close();
    navigate(path);
  };

  const canAdmin = canSeeAdministration(user);
  const canImport = canAccessRoute(user, '/bulk-import');

  // Position classes for the dropdown panel.
  const horizontalCls = align === 'left' ? 'left-0' : 'right-0';
  const verticalCls =
    verticalAlign === 'above' ? 'bottom-full mb-1' : 'top-full mt-1';

  return (
    <div ref={containerRef} className="relative">
      {trigger({ open, onClick: () => setOpen((p) => !p) })}

      {open && (
        <div
          className={`absolute z-50 w-56 rounded-md border border-border bg-card py-1 shadow-lg ${horizontalCls} ${verticalCls}`}
          role="menu"
        >
          {/* User identity header */}
          <div className="flex items-center gap-2.5 border-b border-border px-3 py-2">
            <Avatar name={user?.name} email={user?.email} avatarUrl={user?.avatarUrl} size="sm" />
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-foreground">
                {user?.name || 'User'}
              </p>
              <p className="truncate text-xs text-muted-foreground">{user?.email}</p>
            </div>
          </div>

          {/* Profile / Administration */}
          <MenuItem icon={UserIcon} label="Profile" onClick={() => go('/profile')} />
          {canAdmin && (
            <MenuItem
              icon={ShieldCheck}
              label="Administration"
              onClick={() => go('/admin')}
            />
          )}
          {canImport && (
            <MenuItem
              icon={Upload}
              label="Bulk import"
              onClick={() => go('/bulk-import')}
            />
          )}

          {/* Install CLI */}
          <div className="my-1 border-t border-border" />
          <MenuItem
            icon={Terminal}
            label="Install CLI"
            onClick={() => go('/install-cli')}
          />
          <MenuItem
            icon={Keyboard}
            label="Keyboard shortcuts"
            onClick={() => {
              close();
              window.dispatchEvent(new CustomEvent('shellius:open-shortcuts'));
            }}
          />

          {/* Sign out */}
          <div className="my-1 border-t border-border" />
          <MenuItem
            icon={LogOut}
            label="Sign out"
            destructive
            onClick={() => {
              close();
              logout();
            }}
          />
        </div>
      )}
    </div>
  );
}

function MenuItem({ icon: Icon, label, onClick, destructive = false }) {
  return (
    <button
      type="button"
      onClick={onClick}
      role="menuitem"
      className={
        destructive
          ? 'flex w-full items-center gap-2 px-3 py-2 text-sm text-destructive transition-colors hover:bg-destructive/10 focus:bg-destructive/10'
          : 'flex w-full items-center gap-2 px-3 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground transition-colors'
      }
    >
      <Icon className={destructive ? 'h-4 w-4 text-destructive' : 'h-4 w-4'} />
      {label}
    </button>
  );
}

export default UserMenu;
