import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  AlertTriangle,
  Copy,
  LayoutGrid,
  List,
  Lock,
  MoreHorizontal,
  Pencil,
  Plus,
  RotateCcw,
  ShieldCheck,
  Trash2,
  Users as UsersIcon,
} from 'lucide-react';
import PageHeader from '@/components/common/PageHeader';
import { useUnsavedChanges } from '@/components/admin/AdminFrameContext';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import EmptyState from '@/components/ui/EmptyState';
import UserCell from '@/components/shared/UserCell';
import ConfirmDialog from '@/components/shared/ConfirmDialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import PermissionGrid from '@/components/roles/PermissionGrid';
import RoleFormModal from '@/components/roles/RoleFormModal';
import DeleteRoleDialog from '@/components/roles/DeleteRoleDialog';
import RoleMatrix from '@/components/roles/RoleMatrix';
import { useAuth } from '@/context/AuthContext';
import { getPermissionCatalog, getRole, listRoles, resetRole, updateRole } from '@/services/roleService';
import { cn } from '@/lib/utils';

const BASE_LABEL = { member: 'Member', manager: 'Manager', admin: 'Admin', super_admin: 'Super admin' };
const errMsg = (err, fallback) => err?.response?.data?.error?.message || err?.message || fallback;

function roleKind(role) {
  if (role.locked) return { tone: 'accent', label: 'Owner' };
  if (role.isSystem) return { tone: 'neutral', label: 'Built-in' };
  return { tone: 'info', label: 'Custom' };
}

// ---------------------------------------------------------------------------
// Shared data: catalogue + roles
// ---------------------------------------------------------------------------

function useRolesData() {
  const [catalog, setCatalog] = useState(null);
  const [roles, setRoles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    setError('');
    try {
      const [cat, list] = await Promise.all([getPermissionCatalog(), listRoles()]);
      setCatalog(cat);
      setRoles(list);
    } catch (err) {
      setError(errMsg(err, 'Failed to load roles'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return { catalog, roles, loading, error, reload };
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

function RoleList({ catalog, roles, onNew, onCopy, onDelete }) {
  const { can } = useAuth();
  const total = catalog?.permissions.length || 0;
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <ul className="divide-y divide-border">
        {roles.map((r) => {
          const kind = roleKind(r);
          return (
            <li key={r.id} className="group flex items-center gap-4 px-4 py-3 hover:bg-accent/30">
              <span
                className={cn(
                  'flex h-9 w-9 shrink-0 items-center justify-center rounded-md',
                  r.locked ? 'bg-primary/15 text-primary' : r.isSystem ? 'bg-muted text-muted-foreground' : 'bg-sky-500/15 text-sky-600 dark:text-sky-400'
                )}
              >
                {r.locked ? <Lock className="h-4 w-4" /> : <ShieldCheck className="h-4 w-4" />}
              </span>
              <Link to={`/admin/roles/${r.id}`} className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-1.5">
                  <span className="truncate text-sm font-medium text-foreground group-hover:text-primary">{r.name}</span>
                  <Badge tone={kind.tone}>{kind.label}</Badge>
                  {!r.isSystem && <span className="text-[11px] text-muted-foreground">based on {BASE_LABEL[r.baseRole]}</span>}
                </span>
                <span className="mt-0.5 block truncate text-xs text-muted-foreground">{r.description || '—'}</span>
              </Link>
              <div className="hidden w-40 shrink-0 sm:block">
                <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                  <span className="tabular-nums">
                    {r.permissions.length}/{total} permissions
                  </span>
                  {r.sensitivePermissions?.length > 0 && (
                    <span className="flex items-center gap-0.5 text-amber-600 dark:text-amber-400" title="Sensitive permissions">
                      <AlertTriangle className="h-3 w-3" />
                      {r.sensitivePermissions.length}
                    </span>
                  )}
                </div>
              </div>
              <span className="flex w-16 shrink-0 items-center justify-end gap-1 text-xs tabular-nums text-muted-foreground" title="Users">
                <UsersIcon className="h-3.5 w-3.5" />
                {r.userCount}
              </span>
              {can('roles.manage') && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={`Actions for ${r.name}`}>
                      <MoreHorizontal className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-44">
                    <DropdownMenuItem asChild>
                      <Link to={`/admin/roles/${r.id}`}>
                        <Pencil className="mr-2 h-4 w-4" /> {r.editable ? 'Edit' : 'View'}
                      </Link>
                    </DropdownMenuItem>
                    {r.assignable && (
                      <DropdownMenuItem onClick={() => onCopy(r)}>
                        <Copy className="mr-2 h-4 w-4" /> Duplicate
                      </DropdownMenuItem>
                    )}
                    {!r.isSystem && r.editable && (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => onDelete(r)}>
                          <Trash2 className="mr-2 h-4 w-4" /> Delete
                        </DropdownMenuItem>
                      </>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </li>
          );
        })}
      </ul>
      {can('roles.manage') && (
        <button
          type="button"
          onClick={onNew}
          className="flex w-full items-center gap-2 border-t border-dashed border-border px-4 py-3 text-sm text-muted-foreground hover:bg-accent/30 hover:text-foreground"
        >
          <Plus className="h-4 w-4" /> New custom role
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Detail / editor
// ---------------------------------------------------------------------------

function RoleDetail({ id, catalog, roles, reloadList }) {
  const navigate = useNavigate();
  const { user, can } = useAuth();
  const [role, setRole] = useState(null);
  const [draft, setDraft] = useState([]);
  const [tab, setTab] = useState('permissions');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);
  const [editMeta, setEditMeta] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [copyOpen, setCopyOpen] = useState(false);

  const load = useCallback(async () => {
    setError('');
    try {
      const r = await getRole(id);
      setRole(r);
      setDraft(r.permissions);
    } catch (err) {
      setError(errMsg(err, 'Failed to load role'));
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const grantable = useMemo(() => new Set(user?.permissions || []), [user?.permissions]);
  const dirty = role && draft.join() !== role.permissions.join();
  const canEdit = !!role?.editable && can('roles.manage');

  // Warn before leaving with unsaved changes (reload/close, and switching
  // Administration sections).
  useUnsavedChanges(!!dirty);

  if (error && !role) {
    return <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>;
  }
  if (!role || !catalog) return <div className="h-64 animate-pulse rounded-lg bg-muted" />;

  const kind = roleKind(role);
  const readOnlyReason = role.locked
    ? 'Super admin always has every permission and can’t be changed.'
    : role.id === user?.roleId
      ? 'This is your own role — someone else has to change it.'
      : !can('roles.manage')
        ? 'You can view roles but not change them.'
        : !role.editable
          ? 'This role has permissions you don’t hold, so you can’t change it.'
          : null;

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      await updateRole(role.id, { permissions: draft });
      await load();
      reloadList();
      setNotice('Permissions saved. People with this role get them right away.');
      setTimeout(() => setNotice(''), 4000);
    } catch (err) {
      setError(errMsg(err, 'Failed to save permissions'));
    } finally {
      setSaving(false);
    }
  };

  const doReset = async () => {
    setResetOpen(false);
    setError('');
    try {
      await resetRole(role.id);
      await load();
      reloadList();
      setNotice('Reset to the default permissions.');
      setTimeout(() => setNotice(''), 4000);
    } catch (err) {
      setError(errMsg(err, 'Failed to reset role'));
    }
  };

  return (
    <div className="space-y-5">
      <PageHeader
        back={{ to: '/admin/roles', label: 'All roles' }}
        icon={ShieldCheck}
        helpKey="roles"
        title={
          <span className="flex flex-wrap items-center gap-2">
            {role.name}
            <Badge tone={kind.tone}>{kind.label}</Badge>
            {!role.isSystem && <span className="text-xs font-normal text-muted-foreground">based on {BASE_LABEL[role.baseRole]}</span>}
          </span>
        }
        subtitle={
          <>
            {role.description && <p className="max-w-2xl">{role.description}</p>}
            <p className="mt-0.5 text-xs">
              {role.permissions.length} of {catalog.permissions.length} permissions · {role.userCount} user
              {role.userCount === 1 ? '' : 's'}
              {role.policyRefs > 0 && ` · targeted by ${role.policyRefs} access polic${role.policyRefs === 1 ? 'y' : 'ies'}`}
            </p>
          </>
        }
      >
        {can('roles.manage') && (
          <div className="flex flex-wrap items-center gap-2">
            {canEdit && (
              <Button variant="outline" size="sm" onClick={() => setEditMeta(true)}>
                <Pencil className="mr-1.5 h-3.5 w-3.5" /> Edit details
              </Button>
            )}
            {role.assignable && (
              <Button variant="outline" size="sm" onClick={() => setCopyOpen(true)}>
                <Copy className="mr-1.5 h-3.5 w-3.5" /> Duplicate
              </Button>
            )}
            {canEdit && role.isSystem && (
              <Button variant="outline" size="sm" onClick={() => setResetOpen(true)}>
                <RotateCcw className="mr-1.5 h-3.5 w-3.5" /> Reset to defaults
              </Button>
            )}
            {canEdit && !role.isSystem && (
              <Button variant="outline" size="sm" className="text-destructive hover:text-destructive" onClick={() => setDeleteOpen(true)}>
                <Trash2 className="mr-1.5 h-3.5 w-3.5" /> Delete
              </Button>
            )}
          </div>
        )}
      </PageHeader>

      {readOnlyReason && (
        <div className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          <Lock className="h-3.5 w-3.5 shrink-0" /> {readOnlyReason}
        </div>
      )}
      {error && <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>}
      {notice && (
        <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300">
          {notice}
        </div>
      )}

      <div className="flex items-center gap-1 border-b border-border">
        {[
          { key: 'permissions', label: 'Permissions' },
          { key: 'members', label: `Members (${role.userCount})` },
        ].map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={cn(
              'px-4 py-2.5 text-sm font-medium transition-colors',
              tab === t.key ? 'border-b-2 border-primary text-foreground' : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'permissions' && (
        <div className="pb-20">
          <PermissionGrid
            catalog={catalog}
            value={draft}
            original={role.permissions}
            defaults={role.defaults}
            grantable={grantable}
            onChange={canEdit ? setDraft : undefined}
          />
        </div>
      )}

      {tab === 'members' &&
        (role.users.length === 0 ? (
          <EmptyState icon={UsersIcon} title="No one has this role yet" description="Assign it from Administration → Users." />
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border bg-card">
            {role.users.map((u) => (
              <li key={u.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                <UserCell user={u} />
                {u.status !== 'active' && <Badge tone="neutral">{u.status}</Badge>}
              </li>
            ))}
          </ul>
        ))}

      {/* Sticky save bar while there are unsaved permission changes. */}
      {dirty && (
        <div className="fixed inset-x-0 bottom-4 z-30 flex justify-center px-4">
          <div className="flex w-full max-w-xl items-center justify-between gap-3 rounded-lg border border-border bg-card px-4 py-3 shadow-lg">
            <span className="text-sm text-foreground">
              {(() => {
                const before = new Set(role.permissions);
                const after = new Set(draft);
                const added = draft.filter((p) => !before.has(p)).length;
                const removed = role.permissions.filter((p) => !after.has(p)).length;
                return `${added ? `+${added}` : ''}${added && removed ? ' / ' : ''}${removed ? `−${removed}` : ''} unsaved change${added + removed === 1 ? '' : 's'}`;
              })()}
            </span>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => setDraft(role.permissions)} disabled={saving}>
                Discard
              </Button>
              <Button size="sm" onClick={save} disabled={saving}>
                {saving ? 'Saving…' : 'Save permissions'}
              </Button>
            </div>
          </div>
        </div>
      )}

      <RoleFormModal
        open={editMeta}
        onClose={() => setEditMeta(false)}
        roles={roles}
        role={role}
        onSaved={() => {
          setEditMeta(false);
          load();
          reloadList();
        }}
      />
      <RoleFormModal
        open={copyOpen}
        onClose={() => setCopyOpen(false)}
        roles={roles}
        role={null}
        copyFrom={role.id}
        onSaved={(created) => {
          setCopyOpen(false);
          reloadList();
          navigate(`/admin/roles/${created.id}`);
        }}
      />
      <DeleteRoleDialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        role={role}
        roles={roles}
        policyRefs={role.policyRefs}
        onDeleted={() => {
          setDeleteOpen(false);
          reloadList();
          navigate('/admin/roles');
        }}
      />
      <ConfirmDialog
        open={resetOpen}
        title={`Reset ${role.name} to defaults?`}
        message={`${role.name} goes back to the permissions it had on a fresh install. Everyone with this role is affected right away.`}
        confirmLabel="Reset"
        onConfirm={doReset}
        onCancel={() => setResetOpen(false)}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

function Roles() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { catalog, roles, loading, error, reload } = useRolesData();
  const [view, setView] = useState('list');
  const [newOpen, setNewOpen] = useState(false);
  const [copyFrom, setCopyFrom] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const { can } = useAuth();

  if (id) {
    return (
      <RoleDetail id={id} catalog={catalog} roles={roles} reloadList={reload} />
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader icon={ShieldCheck} title="Roles" subtitle="What each role can do. Every user has one role." helpKey="roles">
        <div className="flex items-center gap-2">
          <div className="flex rounded-md border border-border p-0.5" role="tablist" aria-label="View">
            {[
              { key: 'list', icon: List, label: 'List' },
              { key: 'matrix', icon: LayoutGrid, label: 'Matrix' },
            ].map((v) => (
              <button
                key={v.key}
                type="button"
                role="tab"
                aria-selected={view === v.key}
                onClick={() => setView(v.key)}
                className={cn(
                  'flex h-7 items-center gap-1.5 rounded px-2.5 text-xs font-medium',
                  view === v.key ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground'
                )}
              >
                <v.icon className="h-3.5 w-3.5" /> {v.label}
              </button>
            ))}
          </div>
          {can('roles.manage') && (
            <Button onClick={() => setNewOpen(true)}>
              <Plus className="mr-2 h-4 w-4" /> New role
            </Button>
          )}
        </div>
      </PageHeader>

      {error && <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>}

      {loading ? (
        <div className="h-64 animate-pulse rounded-lg bg-muted" />
      ) : view === 'matrix' ? (
        <RoleMatrix catalog={catalog} roles={roles} />
      ) : (
        <RoleList
          catalog={catalog}
          roles={roles}
          onNew={() => setNewOpen(true)}
          onCopy={(r) => setCopyFrom(r.id)}
          onDelete={(r) => setDeleting(r)}
        />
      )}

      <RoleFormModal
        open={newOpen || !!copyFrom}
        onClose={() => {
          setNewOpen(false);
          setCopyFrom(null);
        }}
        roles={roles}
        role={null}
        copyFrom={copyFrom}
        onSaved={(created) => {
          setNewOpen(false);
          setCopyFrom(null);
          reload();
          navigate(`/admin/roles/${created.id}`);
        }}
      />
      <DeleteRoleDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        role={deleting}
        roles={roles}
        onDeleted={() => {
          setDeleting(null);
          reload();
        }}
      />
    </div>
  );
}

export default Roles;
