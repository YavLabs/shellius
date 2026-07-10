/**
 * SubjectsPicker — unified searchable picker for Users, Groups, and Roles
 * in the Policy form (Step 2 — "Who does this apply to?").
 *
 * Design goals:
 *  - Single search input with 300ms debounce, spanning users + groups + roles.
 *  - Type filter tab strip: All / Users / Groups / Roles.
 *  - Windowed rendering: only the first WINDOW_SIZE rows of each category
 *    are mounted at once; a "Show more" button appends the next batch.
 *  - Selected-subjects strip with colour-coded X chips always visible.
 *  - Loading skeletons during initial fetch.
 *  - Empty states per category.
 *  - No new npm deps — only lucide-react, Tailwind, and existing services.
 *
 * API shape preserved:
 *   form.subjects = [{ subjectType: 'USER'|'GROUP'|'ROLE', subjectId: string, _label: string }]
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { X, Search, Users, UsersRound, ShieldCheck, Loader2 } from 'lucide-react';
import { listUsers } from '@/services/userService';
import { listGroups } from '@/services/groupService';
import { formatLabel } from '@/utils/format';

// How many rows to show per category before "Show more" appears.
const WINDOW_SIZE = 50;

// Static role definitions — these never change.
const ROLES = [
  {
    id: 'super_admin',
    label: 'Super Admin',
    description: 'Full access, bypasses policy evaluation',
  },
  {
    id: 'admin',
    label: 'Admin',
    description: 'Manages users, servers, and policies',
  },
  {
    id: 'manager',
    label: 'Manager',
    description: 'Production access without approval; can approve others',
  },
  {
    id: 'member',
    label: 'Member',
    description: 'Self-serve dev/staging; production requires approval',
  },
];

// Debounce hook — returns the debounced value after `delay` ms.
function useDebounce(value, delay) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

// Initials avatar for users.
function Avatar({ name }) {
  const initials = (name || '?')
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');
  return (
    <div
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[11px] font-semibold text-primary select-none"
      aria-hidden="true"
    >
      {initials}
    </div>
  );
}

// Skeleton row for loading state.
function SkeletonRow() {
  return (
    <div className="flex items-center gap-3 px-3 py-2.5 animate-pulse">
      <div className="h-7 w-7 rounded-full bg-muted shrink-0" />
      <div className="flex-1 space-y-1.5">
        <div className="h-3 w-32 rounded bg-muted" />
        <div className="h-2.5 w-48 rounded bg-muted" />
      </div>
    </div>
  );
}

// Chip for a selected subject — colour-coded by type.
function SubjectChip({ subject, onRemove }) {
  const { subjectType, subjectId, _label } = subject;
  const cls =
    subjectType === 'ROLE'
      ? 'bg-violet-500/15 text-violet-700 dark:text-violet-300 border-violet-500/30'
      : subjectType === 'GROUP'
      ? 'bg-blue-500/12 text-blue-700 dark:text-blue-300 border-blue-500/25'
      : 'bg-primary/12 text-primary border-primary/25';

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium ${cls}`}
    >
      <span className="max-w-[120px] truncate">{_label || subjectId}</span>
      <button
        type="button"
        onClick={() => onRemove(subjectType, subjectId)}
        className="ml-0.5 opacity-60 hover:opacity-100 transition-opacity"
        aria-label={`Remove ${_label || subjectId}`}
      >
        <X className="h-3 w-3" />
      </button>
    </span>
  );
}

// Type filter tab strip.
const TYPE_FILTERS = [
  { key: 'ALL', label: 'All' },
  { key: 'USER', label: 'Users' },
  { key: 'GROUP', label: 'Groups' },
  { key: 'ROLE', label: 'Roles' },
];

function TypeTabStrip({ active, onChange }) {
  return (
    <div className="flex items-center gap-1 border-b border-border px-3 pt-1">
      {TYPE_FILTERS.map((f) => (
        <button
          key={f.key}
          type="button"
          onClick={() => onChange(f.key)}
          className={[
            'px-3 py-1.5 text-xs font-medium transition-colors border-b-2 -mb-px',
            active === f.key
              ? 'border-primary text-primary'
              : 'border-transparent text-muted-foreground hover:text-foreground',
          ].join(' ')}
        >
          {f.label}
        </button>
      ))}
    </div>
  );
}

export default function SubjectsPicker({ subjects = [], onChange }) {
  const [allUsers, setAllUsers] = useState([]);
  const [allGroups, setAllGroups] = useState([]);
  const [loadingUsers, setLoadingUsers] = useState(true);
  const [loadingGroups, setLoadingGroups] = useState(true);

  const [rawSearch, setRawSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('ALL');

  // Windowing state — how many items to show per category.
  const [userLimit, setUserLimit] = useState(WINDOW_SIZE);
  const [groupLimit, setGroupLimit] = useState(WINDOW_SIZE);

  const searchRef = useRef(null);
  const debouncedSearch = useDebounce(rawSearch, 300);

  // Fetch users once (large page, client-side filter).
  useEffect(() => {
    setLoadingUsers(true);
    listUsers({ page: 1, pageSize: 1000 })
      .then((d) => setAllUsers(d.items || d || []))
      .catch(() => setAllUsers([]))
      .finally(() => setLoadingUsers(false));
  }, []);

  // Fetch groups once (API has no search param).
  useEffect(() => {
    setLoadingGroups(true);
    listGroups()
      .then((d) => setAllGroups(Array.isArray(d) ? d : d.items || []))
      .catch(() => setAllGroups([]))
      .finally(() => setLoadingGroups(false));
  }, []);

  // Reset window limits when search or type filter changes.
  useEffect(() => {
    setUserLimit(WINDOW_SIZE);
    setGroupLimit(WINDOW_SIZE);
  }, [debouncedSearch, typeFilter]);

  // Memoised filtered lists — derived from debounced query.
  const filteredUsers = useMemo(() => {
    const q = debouncedSearch.toLowerCase();
    if (!q) return allUsers;
    return allUsers.filter(
      (u) =>
        (u.name || '').toLowerCase().includes(q) ||
        (u.email || '').toLowerCase().includes(q)
    );
  }, [allUsers, debouncedSearch]);

  const filteredGroups = useMemo(() => {
    const q = debouncedSearch.toLowerCase();
    if (!q) return allGroups;
    return allGroups.filter((g) => (g.name || '').toLowerCase().includes(q));
  }, [allGroups, debouncedSearch]);

  const filteredRoles = useMemo(() => {
    const q = debouncedSearch.toLowerCase();
    if (!q) return ROLES;
    return ROLES.filter(
      (r) =>
        r.label.toLowerCase().includes(q) ||
        r.description.toLowerCase().includes(q)
    );
  }, [debouncedSearch]);

  // Quick-lookup set for O(1) selected checks.
  const selectedSet = useMemo(
    () => new Set(subjects.map((s) => `${s.subjectType}:${s.subjectId}`)),
    [subjects]
  );

  const isSelected = useCallback(
    (type, id) => selectedSet.has(`${type}:${id}`),
    [selectedSet]
  );

  const addSubject = useCallback(
    (type, id, label) => {
      if (selectedSet.has(`${type}:${id}`)) return;
      onChange([...subjects, { subjectType: type, subjectId: id, _label: label }]);
    },
    [subjects, selectedSet, onChange]
  );

  const removeSubject = useCallback(
    (type, id) => {
      onChange(subjects.filter((s) => !(s.subjectType === type && s.subjectId === id)));
    },
    [subjects, onChange]
  );

  const toggleUser = useCallback(
    (u) => {
      const label = u.name || u.email;
      isSelected('USER', u.id) ? removeSubject('USER', u.id) : addSubject('USER', u.id, label);
    },
    [isSelected, removeSubject, addSubject]
  );

  const toggleGroup = useCallback(
    (g) => {
      isSelected('GROUP', g.id) ? removeSubject('GROUP', g.id) : addSubject('GROUP', g.id, g.name);
    },
    [isSelected, removeSubject, addSubject]
  );

  const toggleRole = useCallback(
    (r) => {
      isSelected('ROLE', r.id) ? removeSubject('ROLE', r.id) : addSubject('ROLE', r.id, r.label);
    },
    [isSelected, removeSubject, addSubject]
  );

  // Keyboard: Esc clears search.
  const handleSearchKeyDown = (e) => {
    if (e.key === 'Escape') {
      setRawSearch('');
      searchRef.current?.blur();
    }
  };

  // Determine visibility of each category given the active type filter.
  const showUsers = typeFilter === 'ALL' || typeFilter === 'USER';
  const showGroups = typeFilter === 'ALL' || typeFilter === 'GROUP';
  const showRoles = typeFilter === 'ALL' || typeFilter === 'ROLE';

  // Whether the entire results area is in loading state (initial fetches).
  const initialLoading = loadingUsers || loadingGroups;

  // Empty state for the whole panel — shown only when no search is active
  // and the type filter is ALL. Guides the user to type to begin.
  const noSearch = debouncedSearch.trim() === '';
  const showPrompt =
    noSearch &&
    typeFilter === 'ALL' &&
    !initialLoading;

  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden">
      {/* ── Selected strip ─────────────────────────────────────────────── */}
      <div className="border-b border-border px-3 py-2.5 min-h-[2.75rem]">
        {subjects.length === 0 ? (
          <span className="text-xs text-muted-foreground italic">
            Nothing selected yet — search below or pick from the Roles list
          </span>
        ) : (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs font-medium text-muted-foreground shrink-0 mr-0.5">
              Selected ({subjects.length}):
            </span>
            {subjects.map((s) => (
              <SubjectChip
                key={`${s.subjectType}-${s.subjectId}`}
                subject={s}
                onRemove={removeSubject}
              />
            ))}
          </div>
        )}
      </div>

      {/* ── Search input ───────────────────────────────────────────────── */}
      <div className="relative border-b border-border">
        <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <input
          ref={searchRef}
          type="text"
          className="w-full bg-background py-2.5 pl-9 pr-10 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-inset focus:ring-ring"
          placeholder="Search users, groups, or roles..."
          value={rawSearch}
          onChange={(e) => setRawSearch(e.target.value)}
          onKeyDown={handleSearchKeyDown}
          autoComplete="off"
          spellCheck={false}
        />
        {rawSearch && (
          <button
            type="button"
            onClick={() => setRawSearch('')}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            aria-label="Clear search"
          >
            <X className="h-4 w-4" />
          </button>
        )}
        {/* Spinner for re-fetch (currently always client-side but keeps the
            slot for a future server-side search upgrade). */}
        {(rawSearch !== debouncedSearch) && (
          <Loader2 className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground animate-spin" />
        )}
      </div>

      {/* ── Type filter tabs ───────────────────────────────────────────── */}
      <TypeTabStrip active={typeFilter} onChange={setTypeFilter} />

      {/* ── Results area ───────────────────────────────────────────────── */}
      <div className="max-h-80 overflow-y-auto divide-y divide-border">
        {initialLoading ? (
          // Initial load — 5 skeleton rows.
          <>
            <SkeletonRow />
            <SkeletonRow />
            <SkeletonRow />
            <SkeletonRow />
            <SkeletonRow />
          </>
        ) : showPrompt ? (
          // No search query, ALL tab — show roles always + a prompt.
          <>
            {/* Roles section header */}
            <div className="flex items-center gap-2 px-3 py-2 bg-muted/30">
              <ShieldCheck className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Roles
              </span>
            </div>
            {ROLES.map((r) => (
              <RoleRow key={r.id} role={r} selected={isSelected('ROLE', r.id)} onToggle={toggleRole} />
            ))}
            {/* Prompt to search for users/groups */}
            <div className="px-4 py-6 text-center">
              <p className="text-xs text-muted-foreground">
                Type a name or email above to search{' '}
                <strong className="font-medium text-foreground">{allUsers.length}</strong> users
                {allGroups.length > 0 && (
                  <>
                    {' '}and{' '}
                    <strong className="font-medium text-foreground">{allGroups.length}</strong> groups
                  </>
                )}
                .
              </p>
            </div>
          </>
        ) : (
          <>
            {/* ─── Users section ──────────────────────────────────────── */}
            {showUsers && (
              <CategorySection
                icon={<Users className="h-3.5 w-3.5 text-muted-foreground" />}
                label="Users"
                loading={loadingUsers}
                items={filteredUsers}
                limit={userLimit}
                onShowMore={() => setUserLimit((n) => n + WINDOW_SIZE)}
                emptyMessage={
                  debouncedSearch
                    ? `No users match "${debouncedSearch}"`
                    : 'No users found'
                }
                renderRow={(u) => (
                  <UserRow
                    key={u.id}
                    user={u}
                    selected={isSelected('USER', u.id)}
                    onToggle={toggleUser}
                  />
                )}
              />
            )}

            {/* ─── Groups section ─────────────────────────────────────── */}
            {showGroups && (
              <CategorySection
                icon={<UsersRound className="h-3.5 w-3.5 text-muted-foreground" />}
                label="Groups"
                loading={loadingGroups}
                items={filteredGroups}
                limit={groupLimit}
                onShowMore={() => setGroupLimit((n) => n + WINDOW_SIZE)}
                emptyMessage={
                  debouncedSearch
                    ? `No groups match "${debouncedSearch}"`
                    : allGroups.length === 0
                    ? 'No groups yet — create one in the Groups page'
                    : 'No groups found'
                }
                renderRow={(g) => (
                  <GroupRow
                    key={g.id}
                    group={g}
                    selected={isSelected('GROUP', g.id)}
                    onToggle={toggleGroup}
                  />
                )}
              />
            )}

            {/* ─── Roles section ──────────────────────────────────────── */}
            {showRoles && (
              <CategorySection
                icon={<ShieldCheck className="h-3.5 w-3.5 text-muted-foreground" />}
                label="Roles"
                loading={false}
                items={filteredRoles}
                limit={filteredRoles.length} // roles never need windowing (max 4)
                onShowMore={null}
                emptyMessage={`No roles match "${debouncedSearch}"`}
                renderRow={(r) => (
                  <RoleRow
                    key={r.id}
                    role={r}
                    selected={isSelected('ROLE', r.id)}
                    onToggle={toggleRole}
                  />
                )}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ── Category section ─────────────────────────────────────────────────────────

function CategorySection({ icon, label, loading, items, limit, onShowMore, emptyMessage, renderRow }) {
  const visible = items.slice(0, limit);
  const hasMore = items.length > limit;

  return (
    <>
      {/* Section header */}
      <div className="flex items-center gap-2 px-3 py-2 bg-muted/30 sticky top-0 z-10">
        {icon}
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {label}
        </span>
        {!loading && items.length > 0 && (
          <span className="ml-auto text-[10px] text-muted-foreground">
            {items.length} {items.length === 1 ? 'match' : 'matches'}
          </span>
        )}
      </div>

      {loading ? (
        <>
          <SkeletonRow />
          <SkeletonRow />
          <SkeletonRow />
        </>
      ) : items.length === 0 ? (
        <p className="px-4 py-3 text-xs text-muted-foreground">{emptyMessage}</p>
      ) : (
        <>
          {visible.map((item) => renderRow(item))}
          {hasMore && (
            <button
              type="button"
              onClick={onShowMore}
              className="w-full px-4 py-2.5 text-xs text-primary hover:bg-primary/5 transition-colors font-medium"
            >
              Show {Math.min(WINDOW_SIZE, items.length - limit)} more of {items.length - limit} remaining
            </button>
          )}
        </>
      )}
    </>
  );
}

// ── Row components ────────────────────────────────────────────────────────────

function RowWrapper({ selected, accentClass, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors',
        selected ? accentClass : 'hover:bg-accent/40',
      ].join(' ')}
    >
      {children}
    </button>
  );
}

function CheckBox({ checked, accent }) {
  const on =
    accent === 'violet'
      ? 'border-violet-500 bg-violet-500 text-white'
      : accent === 'blue'
      ? 'border-blue-500 bg-blue-500 text-white'
      : 'border-primary bg-primary text-primary-foreground';
  return (
    <div
      className={[
        'flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors',
        checked ? on : 'border-input',
      ].join(' ')}
      aria-hidden="true"
    >
      {checked && (
        <svg
          viewBox="0 0 8 8"
          className="h-2.5 w-2.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="1,4 3,6.5 7,1.5" />
        </svg>
      )}
    </div>
  );
}

function UserRow({ user, selected, onToggle }) {
  return (
    <RowWrapper
      selected={selected}
      accentClass="bg-primary/8"
      onClick={() => onToggle(user)}
    >
      <CheckBox checked={selected} accent="primary" />
      <Avatar name={user.name || user.email} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground leading-tight">
          {user.name || user.email}
        </p>
        {user.name && user.email && (
          <p className="truncate text-[11px] text-muted-foreground leading-tight">
            {user.email}
          </p>
        )}
      </div>
    </RowWrapper>
  );
}

function GroupRow({ group, selected, onToggle }) {
  const memberCount =
    group.memberCount != null
      ? group.memberCount
      : Array.isArray(group.members)
      ? group.members.length
      : null;

  return (
    <RowWrapper
      selected={selected}
      accentClass="bg-blue-500/8"
      onClick={() => onToggle(group)}
    >
      <CheckBox checked={selected} accent="blue" />
      <div
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-blue-500/15"
        aria-hidden="true"
      >
        <UsersRound className="h-3.5 w-3.5 text-blue-600 dark:text-blue-400" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground leading-tight">
          {group.name}
        </p>
        {memberCount != null && (
          <p className="text-[11px] text-muted-foreground leading-tight">
            {memberCount} {memberCount === 1 ? 'member' : 'members'}
          </p>
        )}
      </div>
    </RowWrapper>
  );
}

function RoleRow({ role, selected, onToggle }) {
  return (
    <RowWrapper
      selected={selected}
      accentClass="bg-violet-500/8"
      onClick={() => onToggle(role)}
    >
      <CheckBox checked={selected} accent="violet" />
      <div
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-violet-500/15"
        aria-hidden="true"
      >
        <ShieldCheck className="h-3.5 w-3.5 text-violet-600 dark:text-violet-400" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground leading-tight">
          {formatLabel(role.id)}
        </p>
        <p className="text-[11px] text-muted-foreground leading-tight">
          {role.description}
        </p>
      </div>
    </RowWrapper>
  );
}
