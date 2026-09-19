import { useEffect, useState } from 'react';
import Modal from '@/components/shared/Modal';
import { Button } from '@/components/ui/button';
import SearchableSelect from '@/components/ui/SearchableSelect';
import { useAuth } from '@/context/AuthContext';
import { createRole, updateRole } from '@/services/roleService';

const TIER_RANK = { member: 1, manager: 2, admin: 3, super_admin: 4 };
const BASE_OPTIONS = [
  { value: 'member', label: 'Member', sublabel: 'Matches policies for members' },
  { value: 'manager', label: 'Manager', sublabel: 'Matches policies for managers' },
  { value: 'admin', label: 'Admin', sublabel: 'Matches policies for admins' },
];

const inputCls =
  'h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring';

/**
 * RoleFormModal — create a custom role (blank or copied from another role),
 * or edit a role's name / description / base.
 *
 *   roles     all roles (for "Start from")
 *   role      the role being edited, or null to create
 *   copyFrom  role id to preselect under "Start from"
 */
function RoleFormModal({ open, onClose, roles, role, copyFrom, onSaved }) {
  const { user } = useAuth();
  const isEdit = !!role;
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [baseRole, setBaseRole] = useState('member');
  const [source, setSource] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError('');
    setName(role ? role.name : '');
    setDescription(role?.description || '');
    setBaseRole(role?.baseRole || 'member');
    setSource(copyFrom || '');
    if (!role && copyFrom) {
      const src = roles.find((r) => r.id === copyFrom);
      if (src) {
        setName(`${src.name} (copy)`);
        setBaseRole(src.baseRole === 'super_admin' ? 'admin' : src.baseRole);
      }
    }
  }, [open, role, copyFrom, roles]);

  // A role's base can't be above your own tier; built-ins keep theirs.
  const baseOptions = BASE_OPTIONS.filter((o) => TIER_RANK[o.value] <= (TIER_RANK[user?.role] || 0));
  const sourceOptions = [
    { value: '', label: 'Blank — no permissions' },
    ...roles.filter((r) => r.assignable).map((r) => ({ value: r.id, label: `Copy of ${r.name}`, sublabel: `${r.permissions.length} permissions` })),
  ];

  const onSourceChange = (id) => {
    setSource(id);
    const src = roles.find((r) => r.id === id);
    if (src) setBaseRole(src.baseRole === 'super_admin' ? 'admin' : src.baseRole);
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!name.trim()) {
      setError('Give the role a name');
      return;
    }
    setSaving(true);
    setError('');
    try {
      let saved;
      if (isEdit) {
        const body = { description: description.trim() || null };
        if (!role.isSystem) {
          body.name = name.trim();
          if (baseRole !== role.baseRole) body.baseRole = baseRole;
        }
        saved = await updateRole(role.id, body);
      } else {
        saved = await createRole({
          name: name.trim(),
          description: description.trim() || undefined,
          baseRole,
          ...(source ? { copyFromRoleId: source } : { permissions: [] }),
        });
      }
      onSaved?.(saved);
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message || 'Failed to save role');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={isEdit ? `Edit ${role.name}` : 'New role'}>
      <form onSubmit={submit} className="space-y-4">
        {error && (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>
        )}
        {!isEdit && (
          <div>
            <label className="mb-1.5 block text-sm font-medium text-foreground">Start from</label>
            <SearchableSelect value={source} onChange={onSourceChange} options={sourceOptions} searchable={false} clearable={false} />
            <p className="mt-1 text-[11px] text-muted-foreground">You can change every permission after creating it.</p>
          </div>
        )}
        <div>
          <label className="mb-1.5 block text-sm font-medium text-foreground">
            Name <span className="text-destructive">*</span>
          </label>
          <input
            className={inputCls}
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={60}
            disabled={isEdit && role.isSystem}
            placeholder="e.g. Senior admin"
            autoFocus={!isEdit}
          />
          {isEdit && role.isSystem && <p className="mt-1 text-[11px] text-muted-foreground">Built-in roles keep their name.</p>}
        </div>
        <div>
          <label className="mb-1.5 block text-sm font-medium text-foreground">Description</label>
          <textarea
            className="min-h-[72px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={300}
            placeholder="What people with this role do"
          />
        </div>
        {!(isEdit && role.isSystem) && (
          <div>
            <label className="mb-1.5 block text-sm font-medium text-foreground">Based on</label>
            <SearchableSelect
              value={baseRole}
              onChange={setBaseRole}
              options={baseOptions}
              searchable={false}
              clearable={false}
              renderOption={(o) => (
                <span className="min-w-0">
                  <span className="block">{o.label}</span>
                  <span className="block text-xs text-muted-foreground">{o.sublabel}</span>
                </span>
              )}
            />
            <p className="mt-1 text-[11px] text-muted-foreground">
              Access policies (who may reach which servers) that target this built-in role also apply to the new role.
              Permissions below decide what it can do in Shellius.
            </p>
          </div>
        )}
        <div data-sheet-footer className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? 'Saving…' : isEdit ? 'Save' : 'Create role'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export default RoleFormModal;
