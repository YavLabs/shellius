import { useEffect, useState } from 'react';
import Modal from '@/components/shared/Modal';
import { Button } from '@/components/ui/button';
import SearchableSelect from '@/components/ui/SearchableSelect';
import CustomerScopeSelect from '@/components/shared/CustomerScopeSelect';
import { listRoles } from '@/services/roleService';
import { listCustomers } from '@/services/customerService';
import { createServiceAccount, updateServiceAccount } from '@/services/apiTokenService';

const inputCls =
  'h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring';
const textareaCls =
  'w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring';
const labelCls = 'mb-1.5 block text-sm font-medium text-foreground';

/**
 * Add / edit a service account — an org-owned machine identity with its own
 * Role and customer scope (docs/rbac/customer-scope-spec.md). Status
 * (active/deactivated) is handled by dedicated actions on the list, not
 * here, same as email providers' activate/deactivate.
 *
 * Props: open, onClose, serviceAccount (edit target or null), onSaved(account)
 */
export default function ServiceAccountFormModal({ open, onClose, serviceAccount, onSaved }) {
  const isEdit = !!serviceAccount;
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [roleId, setRoleId] = useState('');
  const [accessScope, setAccessScope] = useState('ALL');
  const [customerIds, setCustomerIds] = useState([]);
  const [roles, setRoles] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError('');
    setSaving(false);
    setName(serviceAccount?.name || '');
    setDescription(serviceAccount?.description || '');
    setRoleId(serviceAccount?.roleId || '');
    setAccessScope(serviceAccount?.accessScope || 'ALL');
    setCustomerIds(serviceAccount?.customerIds || []);
  }, [open, serviceAccount]);

  useEffect(() => {
    if (!open) return;
    listRoles()
      .then((all) => {
        setRoles(all);
        if (!serviceAccount?.roleId) setRoleId((prev) => prev || all.find((r) => r.key === 'member')?.id || '');
      })
      .catch(() => setRoles([]));
    listCustomers({ page: 1, pageSize: 200, isActive: true })
      .then((data) => setCustomers(data.items || []))
      .catch(() => setCustomers([]));
  }, [open, serviceAccount?.roleId]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    if (!name.trim()) {
      setError('Name is required.');
      return;
    }
    if (!roleId) {
      setError('A role is required.');
      return;
    }
    const body = {
      name: name.trim(),
      description: description.trim() || null,
      roleId,
      accessScope,
      customerIds: accessScope === 'CUSTOMERS' ? customerIds : [],
    };
    setSaving(true);
    try {
      const saved = isEdit ? await updateServiceAccount(serviceAccount.id, body) : await createServiceAccount(body);
      onSaved?.(saved);
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message || 'Failed to save service account.');
    } finally {
      setSaving(false);
    }
  };

  const footer = (
    <div className="flex justify-end gap-2">
      <Button type="button" variant="outline" size="sm" onClick={onClose}>
        Cancel
      </Button>
      <Button type="submit" form="service-account-form" size="sm" disabled={saving}>
        {saving ? 'Saving…' : isEdit ? 'Save changes' : 'Create service account'}
      </Button>
    </div>
  );

  return (
    <Modal open={open} onClose={onClose} title={isEdit ? `Edit ${serviceAccount?.name}` : 'Add service account'} size="lg" footer={footer}>
      <form id="service-account-form" onSubmit={handleSubmit} className="space-y-4">
        {error && (
          <div role="alert" className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        <div>
          <label className={labelCls} htmlFor="sa-name">
            Name <span className="text-destructive">*</span>
          </label>
          <input
            id="sa-name"
            className={inputCls}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Terraform CI"
            maxLength={100}
          />
        </div>

        <div>
          <label className={labelCls} htmlFor="sa-description">
            Description <span className="text-muted-foreground">(optional)</span>
          </label>
          <textarea
            id="sa-description"
            rows={2}
            className={textareaCls}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What uses this identity?"
            maxLength={500}
          />
        </div>

        <div>
          <label className={labelCls}>
            Role <span className="text-destructive">*</span>
          </label>
          <SearchableSelect
            value={roleId}
            onChange={setRoleId}
            options={roles
              .filter((r) => r.assignable || r.id === serviceAccount?.roleId)
              .map((r) => ({ value: r.id, label: r.name, sublabel: r.description || undefined, disabled: !r.assignable }))}
            searchable={roles.length > 6}
            clearable={false}
            renderOption={(o) => (
              <span className="min-w-0">
                <span className="block truncate">{o.label}</span>
                {o.sublabel && <span className="block truncate text-xs text-muted-foreground">{o.sublabel}</span>}
              </span>
            )}
          />
          <p className="mt-1 text-[11px] text-muted-foreground">
            What this identity can do — exactly like a user's role, enforced the same way.
          </p>
        </div>

        <div className="space-y-3 rounded-lg border border-border p-3">
          <label className="block text-sm font-medium text-foreground">Customer scope</label>
          <div className="flex gap-1 rounded-md border border-border p-1" role="tablist" aria-label="Customer scope">
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
              customers={customers}
              value={customerIds}
              onChange={setCustomerIds}
              warning="No customers selected — this service account will see nothing."
            />
          )}
          <p className="text-[11px] text-muted-foreground">
            Restricts which customers — and their servers — this service account can see, same as a scoped user.
          </p>
        </div>
      </form>
    </Modal>
  );
}
