import { useCallback, useMemo, useRef, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate, useParams } from 'react-router-dom';
import { Search, ShieldCheck, X, SearchX } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import { AdminFrameContext } from '@/components/admin/AdminFrameContext';
import HelpButton from '@/components/common/HelpButton';
import ConfirmDialog from '@/components/shared/ConfirmDialog';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import {
  filterSections,
  groupSections,
  resolveAdminRoute,
  sectionPath,
  visibleSections,
} from '@/lib/adminSections';
import Users from '@/pages/Users';
import Roles from '@/pages/Roles';
import Groups from '@/pages/Groups';
import GroupDetail from '@/pages/GroupDetail';
import SsoTab from '@/components/settings/SsoTab';
import MfaTab from '@/components/settings/MfaTab';
import AccessSettings from '@/components/settings/AccessSettings';
import OrganizationTab from '@/components/settings/OrganizationTab';
import CaTab from '@/components/settings/CaTab';
import QuickConnectSettings from '@/components/settings/QuickConnectSettings';
import EmailTab from '@/components/settings/email/EmailTab';
import StorageTab from '@/components/settings/StorageTab';

/**
 * What each section renders. `card: true` wraps a former standalone page
 * (Users, Roles, Groups) in a card whose header is that page's PageHeader;
 * the settings sections render their own SectionCard.
 */
const SECTION_VIEWS = {
  users: { card: true, render: () => <Users /> },
  roles: { card: true, render: () => <Roles /> },
  groups: { card: true, render: (id) => (id ? <GroupDetail /> : <Groups />) },
  sso: { render: () => <SsoTab /> },
  mfa: { render: () => <MfaTab /> },
  access: { render: () => <AccessSettings /> },
  organization: { render: () => <OrganizationTab /> },
  ca: { render: () => <CaTab /> },
  'quick-connect': { render: () => <QuickConnectSettings /> },
  email: { render: () => <EmailTab /> },
  storage: { render: () => <StorageTab /> },
};

// Same tint as the sidebar's active item.
const ACTIVE_ROW = 'bg-[hsl(var(--brand)/0.12)] font-medium text-foreground';

function SectionNav({ groups, activeKey, onPick }) {
  return (
    <nav aria-label="Administration sections" className="space-y-3">
      {groups.map((group, idx) => (
        <div key={group.key}>
          {idx > 0 && <div className="mb-3 h-px bg-border" aria-hidden="true" />}
          <p className="mb-1 px-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70 select-none">
            {group.label}
          </p>
          <ul className="space-y-0.5">
            {group.sections.map((s) => {
              const active = s.key === activeKey;
              const Icon = s.icon;
              return (
                <li key={s.key}>
                  <Link
                    to={sectionPath(s.key)}
                    aria-current={active ? 'page' : undefined}
                    onClick={(e) => {
                      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                      e.preventDefault();
                      onPick(s.key);
                    }}
                    className={cn(
                      'group flex items-center gap-2.5 rounded-md px-3 py-1.5 text-sm transition-colors',
                      active ? ACTIVE_ROW : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
                    )}
                  >
                    <Icon
                      className={cn(
                        'h-4 w-4 shrink-0',
                        active ? 'text-primary' : 'text-muted-foreground group-hover:text-foreground'
                      )}
                      aria-hidden="true"
                    />
                    <span className="truncate">{s.label}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

function Administration() {
  const { user } = useAuth();
  const { section: key, id } = useParams();
  const { search } = useLocation();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');

  // Forms inside a section report unsaved edits here (useUnsavedChanges);
  // switching sections asks before discarding them.
  const dirtyRef = useRef(new Set());
  const markDirty = useCallback((formId, dirty) => {
    if (dirty) dirtyRef.current.add(formId);
    else dirtyRef.current.delete(formId);
  }, []);
  const [pendingKey, setPendingKey] = useState(null);

  // Recomputed whenever `user` changes, so a permission change (AuthContext
  // re-reads permissions on focus) shows or hides sections without a reload;
  // if the open section disappears, resolveAdminRoute sends us to /admin.
  const sections = useMemo(() => visibleSections(user), [user]);
  const resolved = resolveAdminRoute(user, key);
  const activeKey = resolved.section?.key;

  const filtered = useMemo(() => filterSections(sections, query), [sections, query]);
  const navGroups = useMemo(() => groupSections(filtered), [filtered]);
  const allGroups = useMemo(() => groupSections(sections), [sections]);

  const frame = useMemo(() => ({ section: activeKey, markDirty }), [activeKey, markDirty]);

  const pick = (next) => {
    if (next === activeKey && !id) return;
    if (dirtyRef.current.size > 0) {
      setPendingKey(next);
      return;
    }
    navigate(sectionPath(next));
  };

  if (resolved.redirect) return <Navigate to={resolved.redirect} replace />;

  // There is no separate user detail page: /admin/users/:id opens that
  // user in the Users list (same as ?highlight=<id>).
  if (activeKey === 'users' && id) {
    const params = new URLSearchParams(search);
    params.set('highlight', id);
    return <Navigate to={`${sectionPath('users')}?${params.toString()}`} replace />;
  }

  const view = SECTION_VIEWS[activeKey];

  return (
    <div className="space-y-6 p-4 sm:p-6">
      {/* Page header */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border bg-[hsl(var(--brand)/0.12)] text-primary">
            <ShieldCheck className="h-5 w-5" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h1 className="text-2xl font-bold tracking-tight">Administration</h1>
            <p className="text-sm text-muted-foreground">Configure people, security and integrations for this organization.</p>
          </div>
        </div>
        <HelpButton helpKey="admin" />
      </div>

      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:gap-6">
        {/* Narrow screens: a picker above the content */}
        <div className="lg:hidden">
          <Select value={activeKey} onValueChange={pick}>
            <SelectTrigger aria-label="Administration section" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {allGroups.map((group, idx) => (
                <SelectGroup key={group.key}>
                  {idx > 0 && <SelectSeparator />}
                  <SelectLabel className="text-[10px] uppercase tracking-wider text-muted-foreground">{group.label}</SelectLabel>
                  {group.sections.map((s) => (
                    <SelectItem key={s.key} value={s.key}>
                      {s.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Wide screens: search + grouped nav, sticky while content scrolls */}
        <div className="hidden w-60 shrink-0 space-y-4 lg:sticky lg:top-6 lg:block">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setQuery('');
                if (e.key === 'Enter' && filtered[0]) pick(filtered[0].key);
              }}
              placeholder="Search settings"
              aria-label="Search settings"
              className="h-9 w-full rounded-md border border-input bg-background pl-9 pr-8 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                className="absolute right-2 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:text-foreground"
                aria-label="Clear search"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          {navGroups.length > 0 ? (
            <SectionNav groups={navGroups} activeKey={activeKey} onPick={pick} />
          ) : (
            <div className="rounded-md border border-dashed border-border px-3 py-6 text-center">
              <SearchX className="mx-auto h-5 w-5 text-muted-foreground/60" aria-hidden="true" />
              <p className="mt-2 break-words text-sm text-muted-foreground">No settings match “{query.trim()}”</p>
              <Button variant="outline" size="sm" className="mt-3" onClick={() => setQuery('')}>
                Clear
              </Button>
            </div>
          )}
        </div>

        {/* Selected section */}
        <div className="min-w-0 flex-1">
          <AdminFrameContext.Provider value={frame}>
            {view?.card ? (
              <div className="rounded-lg border border-border bg-card p-4 sm:p-5">{view.render(id)}</div>
            ) : (
              view?.render(id)
            )}
          </AdminFrameContext.Provider>
        </div>
      </div>

      <ConfirmDialog
        open={!!pendingKey}
        title="Discard unsaved changes?"
        message="You have changes in this section that haven't been saved. Leave without saving?"
        confirmLabel="Discard changes"
        variant="destructive"
        onConfirm={() => {
          const next = pendingKey;
          setPendingKey(null);
          dirtyRef.current.clear();
          navigate(sectionPath(next));
        }}
        onCancel={() => setPendingKey(null)}
      />
    </div>
  );
}

export default Administration;
