import { useCallback, useMemo, useRef, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate, useParams } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Search, ShieldCheck, X, SearchX } from 'lucide-react';
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
import MobilePageHeader from '@/components/mobile/MobilePageHeader';
import PageHeader from '@/components/common/PageHeader';
import useIsMobile from '@/hooks/useIsMobile';
import { cn } from '@/lib/utils';
import {
  ADMIN_BASE,
  filterSections,
  groupSections,
  resolveAdminRoute,
  sectionPath,
  visibleSections,
} from '@/lib/adminSections';
import Users from '@/pages/Users';
import Roles from '@/pages/Roles';
import Groups from '@/pages/Groups';
import Policies from '@/pages/Policies';
import GroupDetail from '@/pages/GroupDetail';
import SsoTab from '@/components/settings/SsoTab';
import MfaTab from '@/components/settings/MfaTab';
import AccessSettings from '@/components/settings/AccessSettings';
import OrganizationTab from '@/components/settings/OrganizationTab';
import CaTab from '@/components/settings/CaTab';
import QuickConnectSettings from '@/components/settings/QuickConnectSettings';
import PostureSettings from '@/components/settings/PostureSettings';
import EmailTab from '@/components/settings/email/EmailTab';
import StorageTab from '@/components/settings/StorageTab';
import ServiceAccountsTab from '@/components/settings/serviceAccounts/ServiceAccountsTab';

/**
 * What each section renders. `card: true` wraps a former standalone page
 * (Users, Roles, Groups) in a card whose header is that page's PageHeader;
 * the settings sections render their own SectionCard.
 */
const SECTION_VIEWS = {
  users: { card: true, render: () => <Users /> },
  roles: { card: true, render: () => <Roles /> },
  groups: { card: true, render: (id) => (id ? <GroupDetail /> : <Groups />) },
  policies: { card: true, render: () => <Policies /> },
  'service-accounts': { render: () => <ServiceAccountsTab /> },
  sso: { render: () => <SsoTab /> },
  mfa: { render: () => <MfaTab /> },
  access: { render: () => <AccessSettings /> },
  organization: { render: () => <OrganizationTab /> },
  ca: { render: () => <CaTab /> },
  'quick-connect': { render: () => <QuickConnectSettings /> },
  posture: { render: () => <PostureSettings /> },
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

/**
 * Phones: the section list is its own screen (like a phone's Settings app)
 * — search on top, then each group as a card of rows (icon, label, one-line
 * description, chevron).
 */
function MobileSectionList({ groups, query, setQuery, onPick, firstMatch }) {
  return (
    <div className="space-y-5">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setQuery('');
            if (e.key === 'Enter' && firstMatch) onPick(firstMatch.key);
          }}
          placeholder="Search settings"
          aria-label="Search settings"
          className="h-11 w-full rounded-lg border border-input bg-background pl-9 pr-10 text-base text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring [&::-webkit-search-cancel-button]:hidden"
        />
        {query && (
          <button
            type="button"
            onClick={() => setQuery('')}
            className="absolute right-0.5 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:text-foreground"
            aria-label="Clear search"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {groups.length > 0 ? (
        <nav aria-label="Administration sections" className="space-y-5">
          {groups.map((group) => (
            <section key={group.key} aria-labelledby={`admin-group-${group.key}`}>
              <h2
                id={`admin-group-${group.key}`}
                className="mb-1.5 px-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground"
              >
                {group.label}
              </h2>
              <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
                {group.sections.map((s) => {
                  const Icon = s.icon;
                  return (
                    <li key={s.key}>
                      <Link
                        to={sectionPath(s.key)}
                        onClick={(e) => {
                          if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                          e.preventDefault();
                          onPick(s.key);
                        }}
                        className="flex min-h-[3.75rem] items-center gap-3 px-3 py-2.5 transition-colors active:bg-accent hover:bg-accent/50"
                      >
                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[hsl(var(--brand)/0.12)] text-primary">
                          <Icon className="h-[18px] w-[18px]" aria-hidden="true" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium text-foreground">{s.label}</span>
                          {s.description && (
                            <span className="block truncate text-xs text-muted-foreground">{s.description}</span>
                          )}
                        </span>
                        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/60" aria-hidden="true" />
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </nav>
      ) : (
        <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center">
          <SearchX className="mx-auto h-5 w-5 text-muted-foreground/60" aria-hidden="true" />
          <p className="mt-2 break-words text-sm text-muted-foreground">No settings match “{query.trim()}”</p>
          <Button variant="outline" className="mt-3 h-11" onClick={() => setQuery('')}>
            Clear
          </Button>
        </div>
      )}
    </div>
  );
}

function Administration() {
  const { user } = useAuth();
  const { section: key, id } = useParams();
  const { search } = useLocation();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const [query, setQuery] = useState('');

  // Forms inside a section report unsaved edits here (useUnsavedChanges);
  // switching sections asks before discarding them.
  const dirtyRef = useRef(new Set());
  const markDirty = useCallback((formId, dirty) => {
    if (dirty) dirtyRef.current.add(formId);
    else dirtyRef.current.delete(formId);
  }, []);
  // Where to go once the user agrees to discard unsaved edits.
  const [pendingPath, setPendingPath] = useState(null);

  // Recomputed whenever `user` changes, so a permission change (AuthContext
  // re-reads permissions on focus) shows or hides sections without a reload;
  // if the open section disappears, resolveAdminRoute sends us to /admin.
  const sections = useMemo(() => visibleSections(user), [user]);
  // Phones: bare /admin is the section list instead of the first section.
  const resolved = resolveAdminRoute(user, key, { listOnBare: isMobile });
  const activeKey = resolved.section?.key;

  const filtered = useMemo(() => filterSections(sections, query), [sections, query]);
  const navGroups = useMemo(() => groupSections(filtered), [filtered]);
  const allGroups = useMemo(() => groupSections(sections), [sections]);

  const frame = useMemo(() => ({ section: activeKey, markDirty }), [activeKey, markDirty]);

  const go = (path) => {
    if (dirtyRef.current.size > 0) {
      setPendingPath(path);
      return;
    }
    navigate(path);
  };
  const pick = (next) => {
    if (next === activeKey && !id) return;
    go(sectionPath(next));
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

  const discardDialog = (
    <ConfirmDialog
      open={!!pendingPath}
      title="Discard unsaved changes?"
      message="You have changes in this section that haven't been saved. Leave without saving?"
      confirmLabel="Discard changes"
      variant="destructive"
      onConfirm={() => {
        const next = pendingPath;
        setPendingPath(null);
        dirtyRef.current.clear();
        navigate(next);
      }}
      onCancel={() => setPendingPath(null)}
    />
  );

  const sectionContent = (
    <AdminFrameContext.Provider value={frame}>
      {view?.card ? (
        <div className="rounded-lg border border-border bg-card p-4 sm:p-5">{view.render(id)}</div>
      ) : (
        view?.render(id)
      )}
    </AdminFrameContext.Provider>
  );

  // Phones (docs/plans/1.5.1-mobile.md §6): the section list, or one section
  // full-width with "‹ Administration" to go back — no dropdown picker.
  if (isMobile) {
    return (
      <div className="space-y-6 p-6">
        {resolved.list ? (
          <>
            <MobilePageHeader
              icon={ShieldCheck}
              title="Administration"
              subtitle="Configure people, security and integrations for this organization."
              helpKey="admin"
            />
            <MobileSectionList
              groups={navGroups}
              query={query}
              setQuery={setQuery}
              onPick={pick}
              firstMatch={filtered[0]}
            />
          </>
        ) : (
          <>
            <div className="flex min-h-11 items-center justify-between">
              <Link
                to={ADMIN_BASE}
                onClick={(e) => {
                  if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                  e.preventDefault();
                  go(ADMIN_BASE);
                }}
                className="-ml-2 flex h-11 items-center gap-0.5 rounded-md pl-1 pr-3 text-sm font-medium text-[hsl(var(--brand))] hover:bg-accent/50"
              >
                <ChevronLeft className="h-5 w-5" aria-hidden="true" />
                Administration
              </Link>
              {/* Users / Roles / Groups have their own help in the card header. */}
              {!view?.card && (
                <span className="-mr-1 [&>button]:h-11 [&>button]:w-11">
                  <HelpButton helpKey="admin" />
                </span>
              )}
            </div>
            {sectionContent}
          </>
        )}
        {discardDialog}
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      {/* Same header as every other page. */}
      <PageHeader
        icon={ShieldCheck}
        title="Administration"
        subtitle="Configure people, security and integrations for this organization."
        helpKey="admin"
      />

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
        <div className="min-w-0 flex-1">{sectionContent}</div>
      </div>

      {discardDialog}
    </div>
  );
}

export default Administration;
