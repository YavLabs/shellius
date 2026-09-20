import { AlertTriangle } from 'lucide-react';
import SearchableSelect from '@/components/ui/SearchableSelect';

/**
 * CustomerScopeSelect — the multi-select used to build a customer-scope
 * assignment: UserForm's "Selected customers" mode and GroupDetail's group
 * scope (docs/rbac/customer-scope-spec.md §2, §4.4). Built on
 * SearchableSelect(multiple) so it works the same on a phone (sheet/popover)
 * as everywhere else, rather than a bespoke picker.
 *
 * An empty selection is valid but almost always a mistake — it means
 * whoever it applies to sees nothing — so this always warns when empty
 * (unless `disabled`).
 *
 * Props:
 *   customers  {Array<{id, name}>}  candidate customers (active, in the org)
 *   value      {string[]}           selected customer ids
 *   onChange   (string[]) => void
 *   disabled?  {boolean}
 *   warning?   {string}             override the empty-selection warning copy
 */
function CustomerScopeSelect({ customers = [], value = [], onChange, disabled = false, warning }) {
  return (
    <div className="space-y-2">
      <SearchableSelect
        multiple
        value={value}
        onChange={onChange}
        options={customers.map((c) => ({ value: c.id, label: c.name }))}
        placeholder="Select customers…"
        searchPlaceholder="Search customers…"
        disabled={disabled}
        emptyMessage="No active customers"
      />
      {!disabled && value.length === 0 && (
        <p className="flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-400">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {warning || 'No customers selected — this means nothing will be visible.'}
        </p>
      )}
    </div>
  );
}

export default CustomerScopeSelect;
