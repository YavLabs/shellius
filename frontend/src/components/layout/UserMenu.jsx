import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  User as UserIcon,
  Settings as SettingsIcon,
  Sun,
  Moon,
  Monitor,
  Terminal,
  LogOut,
  Check,
} from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import { useTheme } from '@/context/ThemeContext';

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
 *   - Profile     → /profile
 *   - Settings    → /settings  (only for admin / super_admin)
 *   - Theme       → light / dark / system radio group
 *   - Install CLI → /install-cli
 *   - Sign out
 */
function UserMenu({ trigger, align = 'right', verticalAlign = 'below' }) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef(null);
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const { theme, setTheme } = useTheme();

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

  const isAdmin = user?.role === 'admin' || user?.role === 'super_admin';

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
          <div className="border-b border-border px-3 py-2">
            <p className="truncate text-sm font-medium text-foreground">
              {user?.name || 'User'}
            </p>
            <p className="truncate text-xs text-muted-foreground">{user?.email}</p>
          </div>

          {/* Profile / Settings */}
          <MenuItem icon={UserIcon} label="Profile" onClick={() => go('/profile')} />
          {isAdmin && (
            <MenuItem
              icon={SettingsIcon}
              label="Settings"
              onClick={() => go('/settings')}
            />
          )}

          {/* Theme group */}
          <div className="my-1 border-t border-border" />
          <p className="px-3 pt-1 pb-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Theme
          </p>
          <ThemeOption
            current={theme}
            value="light"
            label="Light"
            icon={Sun}
            onSelect={setTheme}
          />
          <ThemeOption
            current={theme}
            value="dark"
            label="Dark"
            icon={Moon}
            onSelect={setTheme}
          />
          <ThemeOption
            current={theme}
            value="system"
            label="System"
            icon={Monitor}
            onSelect={setTheme}
          />

          {/* Install CLI */}
          <div className="my-1 border-t border-border" />
          <MenuItem
            icon={Terminal}
            label="Install CLI"
            onClick={() => go('/install-cli')}
          />

          {/* Sign out */}
          <div className="my-1 border-t border-border" />
          <MenuItem
            icon={LogOut}
            label="Sign out"
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

function MenuItem({ icon: Icon, label, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      role="menuitem"
      className="flex w-full items-center gap-2 px-3 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
    >
      <Icon className="h-4 w-4" />
      {label}
    </button>
  );
}

function ThemeOption({ current, value, label, icon: Icon, onSelect }) {
  const active = current === value;
  return (
    <button
      type="button"
      onClick={() => onSelect(value)}
      role="menuitemradio"
      aria-checked={active}
      className="flex w-full items-center gap-2 px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
    >
      <Icon className="h-4 w-4" />
      <span className="flex-1 text-left">{label}</span>
      {active && <Check className="h-3.5 w-3.5 text-primary" />}
    </button>
  );
}

export default UserMenu;
