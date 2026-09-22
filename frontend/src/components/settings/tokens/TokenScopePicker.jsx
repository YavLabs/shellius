import { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { Checkbox } from '@/components/ui/checkbox';
import { groupPermissionsForPicker } from './tokenHelpers';

/**
 * TokenScopePicker — narrows a token down to a subset of the permission
 * catalogue (GET /api/roles/catalog, same endpoint and grouping as the role
 * editor's PermissionGrid — components/roles/PermissionGrid.jsx — so this
 * reads as the same idea in two places). An empty selection means "no
 * restriction beyond what the token's owner can already do", which is the
 * backend default; this component only ever adds restrictions on top.
 *
 * `grantable`, if given, is the extra allow-list beyond delegability alone
 * — e.g. a personal token can only be scoped to permissions the requesting
 * user currently holds. Permissions the catalogue marks non-delegable
 * (`delegable: false`) are always hidden, since the backend refuses them
 * outright.
 *
 * Props:
 *   catalog     { groups, permissions } | null — from roleService.getPermissionCatalog()
 *   value       string[] — selected permission keys
 *   onChange    (next: string[]) => void
 *   grantable?  Set<string> | null
 */
function TokenScopePicker({ catalog, value, onChange, grantable = null }) {
  const [query, setQuery] = useState('');
  const selected = useMemo(() => new Set(value || []), [value]);

  const groups = useMemo(
    () => groupPermissionsForPicker(catalog, { query, grantable }),
    [catalog, query, grantable]
  );

  const toggle = (key, next) => {
    const copy = new Set(selected);
    if (next) copy.add(key);
    else copy.delete(key);
    onChange([...copy]);
  };

  if (!catalog) return null;

  return (
    <div className="space-y-3">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search permissions…"
          className="h-8 w-full rounded-md border border-input bg-background pl-8 pr-3 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
        />
      </div>

      {groups.length === 0 && (
        <p className="py-4 text-center text-xs text-muted-foreground">
          {query ? `No permissions match “${query}”.` : 'No permissions are available to grant.'}
        </p>
      )}

      <div className="max-h-72 space-y-3 overflow-y-auto pr-1">
        {groups.map((g) => (
          <section key={g.key} className="overflow-hidden rounded-md border border-border">
            <header className="flex items-center justify-between gap-2 border-b border-border bg-muted/30 px-3 py-1.5">
              <span className="text-xs font-semibold text-foreground">{g.label}</span>
              <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                {g.items.filter((p) => selected.has(p.key)).length}/{g.items.length}
              </span>
            </header>
            <ul className="divide-y divide-border">
              {g.items.map((p) => (
                <li key={p.key} className="flex items-start gap-2.5 px-3 py-2">
                  <Checkbox
                    id={`scope-${p.key}`}
                    checked={selected.has(p.key)}
                    onChange={(e) => toggle(p.key, e.target.checked)}
                    className="mt-0.5"
                  />
                  <label htmlFor={`scope-${p.key}`} className="min-w-0 flex-1 cursor-pointer">
                    <span className="block text-xs font-medium text-foreground">{p.label}</span>
                    {p.description && <span className="block text-[11px] text-muted-foreground">{p.description}</span>}
                  </label>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}

export default TokenScopePicker;
