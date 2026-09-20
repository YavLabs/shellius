import { useState, useEffect, useMemo } from 'react';
import { listUsers, getUserEffectiveScope } from '@/services/userService';
import api from '@/services/api';
import PasswordInput from '@/components/ui/PasswordInput';
import SearchableSelect from '@/components/ui/SearchableSelect';
import CustomerScopeSelect from '@/components/shared/CustomerScopeSelect';
import EffectiveAccessSummary from '@/components/users/EffectiveAccessSummary';
import Avatar from '@/components/ui/Avatar';
import { USER_STATUS_LABELS } from '@/lib/labels';
import { useAuth } from '@/context/AuthContext';
import { listRoles } from '@/services/roleService';
import { listCustomers } from '@/services/customerService';
import { listGroups, getGroup } from '@/services/groupService';

// Sorted-set comparison for the two customerId arrays — order doesn't matter.
function sameIds(a = [], b = []) {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

const STATUSES = ['active', 'invited', 'suspended', 'deactivated'];

// Normalizes GET /users/:id/effective-scope into EffectiveAccessSummary's
// `view` shape — see backend/src/services/userService.js getEffectiveScope.
function normalizeApiEffective(data) {
  if (!data) return null;
  if (data.kind === 'all') {
    return {
      kind: 'all',
      reason: data.reason,
      allGroups: data.reason === 'group_all' ? (data.sources?.groups || []).filter((g) => g.accessScope === 'ALL') : [],
    };
  }
  const map = new Map();
  (data.sources?.direct || []).forEach((c) => {
    map.set(c.id, { id: c.id, name: c.name, viaDirect: true, viaGroups: [] });
  });
  (data.sources?.groups || [])
    .filter((g) => g.accessScope === 'CUSTOMERS')
    .forEach((g) => {
      (g.customers || []).forEach((c) => {
        const entry = map.get(c.id) || { id: c.id, name: c.name, viaDirect: false, viaGroups: [] };
        entry.viaGroups.push(g.name);
        map.set(c.id, entry);
      });
    });
  return { kind: 'customers', reason: data.reason, customers: [...map.values()] };
}

/**
 * Client-side mirror of getEffectiveScope's priority — own ALL (or a
 * super_admin role) wins outright, then any selected ALL-scope group, then
 * the union of direct + group CUSTOMERS grants, which may be empty. Used to
 * preview the *unsaved* form state (create, or edits not yet saved).
 */
function computePendingEffective({ isSuperAdmin, accessScope, scopeCustomerIds, selectedGroups, customerNameById }) {
  if (isSuperAdmin || accessScope !== 'CUSTOMERS') {
    return { kind: 'all', reason: 'user_all', allGroups: [] };
  }
  const allGroups = selectedGroups.filter((g) => g.accessScope === 'ALL');
  if (allGroups.length > 0) {
    return { kind: 'all', reason: 'group_all', allGroups };
  }
  const map = new Map();
  scopeCustomerIds.forEach((id) => {
    map.set(id, { id, name: customerNameById.get(id) || id, viaDirect: true, viaGroups: [] });
  });
  selectedGroups
    .filter((g) => g.accessScope === 'CUSTOMERS')
    .forEach((g) => {
      (g.customerIds || []).forEach((id) => {
        const entry = map.get(id) || { id, name: customerNameById.get(id) || id, viaDirect: false, viaGroups: [] };
        entry.viaGroups.push(g.name);
        map.set(id, entry);
      });
    });
  const customers = [...map.values()];
  return { kind: 'customers', reason: customers.length > 0 ? 'union' : 'empty', customers };
}

function UserForm({ user, onSubmit, onCancel }) {
  const isEdit = !!user;
  const [name, setName] = useState(user?.name || '');
  const [email, setEmail] = useState(user?.email || '');
  const [password, setPassword] = useState('');
  const { user: me, can } = useAuth();
  const isSelf = isEdit && user?.id === me?.id;
  // Roles come from the API (built-in + custom). Only roles whose
  // permissions you hold yourself are offered (the API enforces the same).
  const [roles, setRoles] = useState([]);
  const [roleId, setRoleId] = useState(user?.roleId || '');
  const canAssign = can('users.assign_role') && !isSelf;
  const [status, setStatus] = useState(user?.status || 'active');
  const [managerId, setManagerId] = useState(user?.managerId || '');
  const [managers, setManagers] = useState([]);
  // 'email' = send a set-password invite; 'set' = admin sets the password now.
  const [pwMode, setPwMode] = useState('email');
  const [ssoEnabled, setSsoEnabled] = useState(false);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Customer scope (docs/rbac/customer-scope-spec.md) — a user can be
  // restricted to a subset of Customers instead of seeing the whole org.
  // Gated on its own permission; nobody edits their own scope.
  const canAssignScope = can('users.assign_scope') && !isSelf;
  const [accessScope, setAccessScope] = useState(user?.accessScope || 'ALL');
  const [scopeCustomerIds, setScopeCustomerIds] = useState(user?.customerIds || []);
  const [scopeCustomers, setScopeCustomers] = useState([]);

  // Group membership (docs/rbac/customer-scope-spec.md §2, §4.4) — gated on
  // its own permission; a group can widen a scoped user's access, including
  // all the way to "entire organization" (an ALL-scope group), which is why
  // it feeds the effective-access summary below rather than standing alone.
  const canManageGroups = can('groups.manage');
  const initialGroupIds = useMemo(() => (user?.groups || []).map((g) => g.id), [user]);
  const [groupIds, setGroupIds] = useState(initialGroupIds);
  const [allGroups, setAllGroups] = useState([]);
  // Per-group detail (accessScope + customerIds) for selected CUSTOMERS-scope
  // groups, fetched lazily — listGroups() doesn't return customerIds.
  const [groupDetails, setGroupDetails] = useState({});

  // The saved, authoritative effective scope (edit mode only) — what the API
  // says this user sees *right now*, before any unsaved edits below.
  const [savedEffective, setSavedEffective] = useState(null);
  const [loadingEffective, setLoadingEffective] = useState(false);
  const [effectiveError, setEffectiveError] = useState('');

  useEffect(() => {
    if (!canAssignScope) return;
    listCustomers({ page: 1, pageSize: 200, isActive: true })
      .then((data) => setScopeCustomers(data.items || []))
      .catch(() => setScopeCustomers([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canAssignScope]);

  useEffect(() => {
    if (!canManageGroups) return;
    listGroups()
      .then((all) => setAllGroups(all || []))
      .catch(() => setAllGroups([]));
  }, [canManageGroups]);

  // Uses `users.view` server-side, not `users.assign_scope` — anyone who can
  // manage this user's groups should see what that actually grants, even if
  // they can't touch the user's own accessScope directly.
  const showEffectiveAccess = canAssignScope || canManageGroups;
  useEffect(() => {
    if (!isEdit || !showEffectiveAccess || !user?.id) return;
    setLoadingEffective(true);
    setEffectiveError('');
    getUserEffectiveScope(user.id)
      .then((data) => setSavedEffective(data))
      .catch((err) => setEffectiveError(err.response?.data?.error?.message || 'Failed to load effective access'))
      .finally(() => setLoadingEffective(false));
  }, [isEdit, showEffectiveAccess, user?.id]);

  // Fetch customerIds for any newly-selected CUSTOMERS-scope group so the
  // pending preview can list which customers it actually grants.
  useEffect(() => {
    const missing = groupIds.filter((id) => {
      const g = allGroups.find((g) => g.id === id);
      return g && g.accessScope === 'CUSTOMERS' && !groupDetails[id];
    });
    if (missing.length === 0) return;
    let cancelled = false;
    Promise.all(missing.map((id) => getGroup(id).catch(() => null))).then((results) => {
      if (cancelled) return;
      setGroupDetails((prev) => {
        const next = { ...prev };
        results.forEach((g) => {
          if (g) next[g.id] = { accessScope: g.accessScope, customerIds: g.customerIds || [] };
        });
        return next;
      });
    });
    return () => { cancelled = true; };
  }, [groupIds, allGroups, groupDetails]);

  // Selected groups enriched with the detail (accessScope/customerIds) the
  // pending preview needs — falls back to just accessScope until the detail
  // fetch above resolves.
  const selectedGroupObjs = useMemo(
    () =>
      groupIds
        .map((id) => allGroups.find((g) => g.id === id))
        .filter(Boolean)
        .map((g) => ({ id: g.id, name: g.name, accessScope: g.accessScope, customerIds: groupDetails[g.id]?.customerIds || [] })),
    [groupIds, allGroups, groupDetails]
  );
  const customerNameById = useMemo(() => new Map(scopeCustomers.map((c) => [c.id, c.name])), [scopeCustomers]);
  const selectedRole = roles.find((r) => r.id === roleId);
  const isSuperAdminRole = selectedRole?.key === 'super_admin';

  // Anything the effective-access preview depends on that hasn't been saved
  // yet — while this is false (edit mode, nothing touched) we show the
  // authoritative API snapshot instead of recomputing it ourselves.
  const scopeOrGroupsDirty =
    !isEdit ||
    accessScope !== (user?.accessScope || 'ALL') ||
    !sameIds(scopeCustomerIds, user?.customerIds || []) ||
    !sameIds(groupIds, initialGroupIds) ||
    roleId !== (user?.roleId || '');

  const pendingView = useMemo(
    () =>
      computePendingEffective({
        isSuperAdmin: isSuperAdminRole,
        accessScope,
        scopeCustomerIds,
        selectedGroups: selectedGroupObjs,
        customerNameById,
      }),
    [isSuperAdminRole, accessScope, scopeCustomerIds, selectedGroupObjs, customerNameById]
  );
  const effectiveView = scopeOrGroupsDirty ? pendingView : normalizeApiEffective(savedEffective);

  useEffect(() => {
    listRoles()
      .then((all) => {
        setRoles(all);
        if (!user?.roleId) setRoleId(all.find((r) => r.key === 'member')?.id || '');
      })
      .catch(() => setRoles([]));
  }, [user?.roleId]);

  // Load candidate managers (everyone except the user being edited).
  useEffect(() => {
    listUsers({ pageSize: 200 })
      .then((res) => {
        const items = res?.items || res?.data?.items || res || [];
        // Managers can only be super_admin / admin / manager (not members).
        const eligible = ['super_admin', 'admin', 'manager'];
        setManagers(
          (Array.isArray(items) ? items : []).filter(
            (u) => u.id !== user?.id && eligible.includes(u.role)
          )
        );
      })
      .catch(() => setManagers([]));
    // Whether SSO is configured — if so, new users sign in via SSO (no password).
    api
      .get('/auth/sso/public-status')
      .then((r) => setSsoEnabled(!!r.data?.data?.enabled))
      .catch(() => setSsoEnabled(false));
  }, [user?.id]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    if (!name.trim() || !email.trim()) {
      setError('Name and email are required');
      return;
    }
    const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRe.test(email)) {
      setError('Invalid email format');
      return;
    }

    // Only send what changed — each field has its own permission.
    const payload = { name: name.trim() };
    if (!isEdit || email.trim() !== user.email) payload.email = email.trim();
    if (canAssign && roleId && roleId !== user?.roleId) payload.roleId = roleId;
    if (managerId !== (user?.managerId || '')) payload.managerId = managerId || null;
    if (!isEdit && !managerId) delete payload.managerId;

    // Group membership — sent directly on create/update (POST/PUT /users),
    // unlike customer scope which is its own endpoint. Only sent when it
    // actually changed (or on create, when non-empty) since it needs its
    // own permission server-side.
    if (canManageGroups) {
      const changed = isEdit ? !sameIds(groupIds, initialGroupIds) : groupIds.length > 0;
      if (changed) payload.groupIds = groupIds;
    }

    if (isEdit) {
      if (status !== user.status) payload.status = status;
    } else if (ssoEnabled) {
      // SSO configured — no password; send the "sign in with SSO" invite.
      payload.sendInvite = true;
    } else if (pwMode === 'set') {
      if (password.length < 8) {
        setError('Password must be at least 8 characters');
        return;
      }
      payload.password = password; // active immediately, no email
    } else {
      // Send a set-password email invite.
      payload.sendInvite = true;
    }

    // Customer scope goes through its own endpoint (PUT /users/:id/scope),
    // never the general update — attach it to the payload only when it
    // actually changed, so onSubmit knows to make the extra call, and only
    // after saving the base fields (docs/rbac/customer-scope-spec.md).
    if (canAssignScope) {
      const prevScope = user?.accessScope || 'ALL';
      const prevIds = user?.customerIds || [];
      const changed = isEdit
        ? accessScope !== prevScope || (accessScope === 'CUSTOMERS' && !sameIds(scopeCustomerIds, prevIds))
        : accessScope !== 'ALL' || scopeCustomerIds.length > 0;
      if (changed) {
        payload.scope = {
          accessScope,
          customerIds: accessScope === 'CUSTOMERS' ? scopeCustomerIds : [],
        };
      }
    }

    setSubmitting(true);
    try {
      await onSubmit(payload);
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message || 'Failed to save');
    } finally {
      setSubmitting(false);
    }
  };

  const inputCls =
    'h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring';

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <div>
        <label className="mb-1.5 block text-sm font-medium text-foreground">Name <span className="text-destructive">*</span></label>
        <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} required />
      </div>

      <div>
        <label className="mb-1.5 block text-sm font-medium text-foreground">Email <span className="text-destructive">*</span></label>
        <input
          type="email"
          className={inputCls}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
      </div>

      {!isEdit && (
        ssoEnabled ? (
          <div className="rounded-md border border-blue-500/40 bg-blue-500/10 px-3 py-2 text-sm text-blue-700 dark:text-blue-300">
            SSO is configured — this user will sign in with single sign-on. No password is
            needed; they&apos;ll receive an invitation email.
          </div>
        ) : (
          <div className="space-y-2">
            <label className="block text-sm font-medium text-foreground">Password setup</label>
            <div className="flex flex-col gap-2">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="pwMode"
                  checked={pwMode === 'email'}
                  onChange={() => setPwMode('email')}
                  className="h-4 w-4 accent-primary"
                />
                Send the user an email to set their own password
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="pwMode"
                  checked={pwMode === 'set'}
                  onChange={() => setPwMode('set')}
                  className="h-4 w-4 accent-primary"
                />
                Set a password now
              </label>
            </div>
            {pwMode === 'set' && (
              <div>
                <label className="mb-1.5 block text-sm font-medium text-foreground">Password <span className="text-destructive">*</span></label>
                <PasswordInput
                  className={inputCls}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Minimum 8 characters"
                  autoComplete="new-password"
                />
              </div>
            )}
          </div>
        )
      )}

      <div>
        <label className="mb-1.5 block text-sm font-medium text-foreground">Role <span className="text-destructive">*</span></label>
        <SearchableSelect
          value={roleId}
          onChange={(v) => setRoleId(v)}
          options={roles
            .filter((r) => r.assignable || r.id === user?.roleId)
            .map((r) => ({ value: r.id, label: r.name, sublabel: r.description || undefined, disabled: !r.assignable }))}
          searchable={roles.length > 6}
          clearable={false}
          disabled={!canAssign}
          renderOption={(o) => (
            <span className="min-w-0">
              <span className="block truncate">{o.label}</span>
              {o.sublabel && <span className="block truncate text-xs text-muted-foreground">{o.sublabel}</span>}
            </span>
          )}
        />
        {isSelf && <p className="mt-1 text-[11px] text-muted-foreground">You can’t change your own role.</p>}
        {!isSelf && !can('users.assign_role') && (
          <p className="mt-1 text-[11px] text-muted-foreground">Changing roles needs the “Assign roles” permission.</p>
        )}
      </div>

      {isEdit && !isSelf && can('users.suspend') && (
        <div>
          <label className="mb-1.5 block text-sm font-medium text-foreground">Status</label>
          <SearchableSelect
            value={status}
            onChange={(v) => setStatus(v)}
            options={STATUSES.map((s) => ({ value: s, label: USER_STATUS_LABELS[s] || s }))}
            searchable={false}
            clearable={false}
          />
        </div>
      )}

      <div>
        <label className="mb-1.5 block text-sm font-medium text-foreground">
          Manager <span className="text-muted-foreground">(optional)</span>
        </label>
        <SearchableSelect
          value={managerId}
          onChange={(v) => setManagerId(v)}
          options={managers.map((m) => ({
            value: m.id,
            label: m.name || m.email,
            sublabel: m.email,
            avatarUrl: m.avatarUrl,
          }))}
          placeholder="— None —"
          clearable={true}
          renderOption={(o) => (
            <span className="flex items-center gap-2">
              <Avatar size="xs" name={o.label} email={o.sublabel} src={o.avatarUrl} />
              <span className="min-w-0">
                <span className="block truncate">{o.label}</span>
                <span className="block truncate text-xs text-muted-foreground">{o.sublabel}</span>
              </span>
            </span>
          )}
          renderValue={(o) => (
            <span className="flex items-center gap-2">
              <Avatar size="xs" name={o.label} email={o.sublabel} src={o.avatarUrl} />
              <span className="truncate">{o.label}</span>
            </span>
          )}
        />
      </div>

      {can('users.assign_scope') && (
        <div className="space-y-3 rounded-lg border border-border p-3">
          <label className="block text-sm font-medium text-foreground">Access scope</label>
          {isSelf ? (
            <p className="text-xs text-muted-foreground">
              You can’t change your own access scope — ask another admin.
            </p>
          ) : (
            <>
              <div className="flex gap-1 rounded-md border border-border p-1" role="tablist" aria-label="Access scope">
                <button
                  type="button"
                  role="tab"
                  aria-selected={accessScope === 'ALL'}
                  onClick={() => setAccessScope('ALL')}
                  className={`flex-1 rounded px-2 py-1.5 text-xs font-medium ${
                    accessScope === 'ALL' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'
                  }`}
                >
                  Entire organization
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={accessScope === 'CUSTOMERS'}
                  onClick={() => setAccessScope('CUSTOMERS')}
                  className={`flex-1 rounded px-2 py-1.5 text-xs font-medium ${
                    accessScope === 'CUSTOMERS' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'
                  }`}
                >
                  Selected customers
                </button>
              </div>
              {accessScope === 'CUSTOMERS' && (
                <CustomerScopeSelect
                  customers={scopeCustomers}
                  value={scopeCustomerIds}
                  onChange={setScopeCustomerIds}
                  warning="No customers selected — this user will see nothing."
                />
              )}
              <p className="text-[11px] text-muted-foreground">
                Restricts which customers — and their servers — this user can see. Groups they
                belong to may grant additional customers.
              </p>
            </>
          )}
        </div>
      )}

      {canManageGroups && (
        <div>
          <label className="mb-1.5 block text-sm font-medium text-foreground">
            Groups <span className="text-muted-foreground">(optional)</span>
          </label>
          <SearchableSelect
            multiple
            value={groupIds}
            onChange={setGroupIds}
            options={allGroups.map((g) => ({
              value: g.id,
              label: g.name,
              sublabel: g.accessScope === 'ALL' ? 'Entire organization' : undefined,
            }))}
            placeholder="Select groups…"
            searchPlaceholder="Search groups…"
            emptyMessage="No groups"
            renderOption={(o) => (
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="truncate">{o.label}</span>
                {o.sublabel && (
                  <span className="shrink-0 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-400">
                    {o.sublabel}
                  </span>
                )}
              </span>
            )}
          />
          <p className="mt-1.5 text-[11px] text-muted-foreground">
            Adding this user to a group whose scope is “Entire organization” overrides any
            customer restriction they have — see “Effective access” below.
          </p>
        </div>
      )}

      {showEffectiveAccess && !isSelf && (
        <EffectiveAccessSummary
          view={effectiveView}
          live={scopeOrGroupsDirty}
          loading={isEdit && loadingEffective}
          error={effectiveError}
        />
      )}

      <div data-sheet-footer className="flex justify-end gap-2 pt-2">
        <button
          type="button"
          onClick={onCancel}
          className="h-9 rounded-md border border-input bg-background px-4 text-sm font-medium text-foreground hover:bg-accent"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={submitting}
          className="h-9 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {submitting ? 'Saving...' : isEdit ? 'Save changes' : 'Create user'}
        </button>
      </div>
    </form>
  );
}

export default UserForm;
