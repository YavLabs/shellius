import { useMemo, useState } from 'react';
import { AlertTriangle, ChevronDown, Search } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

/**
 * PermissionGrid — the role editor's permission switches, grouped by area.
 *
 *   catalog      { groups: [{key,label}], permissions: [{key,group,label,description,sensitive}] }
 *   value        string[] — permissions currently switched on
 *   onChange     (next: string[]) => void; omit for read-only
 *   grantable    Set<string> — permissions the viewer holds (only those can be
 *                switched on; the API refuses the rest)
 *   defaults     string[] | null — built-in role defaults, to mark changes
 *   original     string[] — saved state, to mark unsaved changes
 */
function PermissionGrid({ catalog, value, onChange, grantable, defaults, original }) {
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState(() => new Set());
  const readOnly = !onChange;
  const on = useMemo(() => new Set(value), [value]);
  const saved = useMemo(() => new Set(original || value), [original, value]);
  const defaultSet = useMemo(() => (defaults ? new Set(defaults) : null), [defaults]);

  const q = query.trim().toLowerCase();
  const groups = catalog.groups
    .map((g) => ({
      ...g,
      items: catalog.permissions.filter(
        (p) =>
          p.group === g.key &&
          (!q || p.label.toLowerCase().includes(q) || p.description.toLowerCase().includes(q) || p.key.includes(q))
      ),
    }))
    .filter((g) => g.items.length > 0);

  const canToggle = (key) => !readOnly && (on.has(key) || grantable?.has(key));
  const set = (key, next) => {
    if (!canToggle(key)) return;
    const copy = new Set(on);
    if (next) copy.add(key);
    else copy.delete(key);
    onChange(catalog.permissions.map((p) => p.key).filter((k) => copy.has(k)));
  };
  const setGroup = (items, next) => {
    const copy = new Set(on);
    for (const p of items) {
      if (!canToggle(p.key)) continue;
      if (next) copy.add(p.key);
      else copy.delete(p.key);
    }
    onChange(catalog.permissions.map((p) => p.key).filter((k) => copy.has(k)));
  };
  const toggleCollapsed = (key) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <div className="space-y-3">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search permissions…"
          className="h-9 w-full rounded-md border border-input bg-background pl-9 pr-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
        />
      </div>

      {groups.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">No permissions match “{query}”.</p>}

      {groups.map((g) => {
        const enabled = g.items.filter((p) => on.has(p.key)).length;
        const isCollapsed = collapsed.has(g.key) && !q;
        const toggleable = g.items.filter((p) => canToggle(p.key));
        const allOn = toggleable.length > 0 && toggleable.every((p) => on.has(p.key));
        return (
          <section key={g.key} className="overflow-hidden rounded-lg border border-border bg-card">
            <header className="flex items-center gap-3 border-b border-border bg-muted/30 px-4 py-2.5">
              <button
                type="button"
                onClick={() => toggleCollapsed(g.key)}
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
                aria-expanded={!isCollapsed}
              >
                <ChevronDown className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform', isCollapsed && '-rotate-90')} />
                <span className="truncate text-sm font-semibold text-foreground">{g.label}</span>
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                  {enabled}/{g.items.length}
                </span>
              </button>
              {!readOnly && toggleable.length > 1 && (
                <button
                  type="button"
                  onClick={() => setGroup(g.items, !allOn)}
                  className="shrink-0 text-xs font-medium text-primary hover:underline"
                >
                  {allOn ? 'Turn all off' : 'Turn all on'}
                </button>
              )}
            </header>
            {!isCollapsed && (
              <ul className="divide-y divide-border">
                {g.items.map((p) => {
                  const checked = on.has(p.key);
                  const locked = !canToggle(p.key);
                  const changed = checked !== saved.has(p.key);
                  const differsFromDefault = defaultSet && checked !== defaultSet.has(p.key);
                  return (
                    <li key={p.key} className={cn('flex items-center gap-4 px-4 py-3', changed && 'bg-primary/5')}>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="text-sm font-medium text-foreground">{p.label}</span>
                          {p.sensitive && (
                            <Badge tone="warning" icon={AlertTriangle}>
                              Sensitive
                            </Badge>
                          )}
                          {differsFromDefault && !changed && (
                            <Badge tone="info" variant="outline">
                              {checked ? 'Added' : 'Removed'} vs default
                            </Badge>
                          )}
                          {changed && (
                            <Badge tone="accent" variant="outline">
                              Unsaved
                            </Badge>
                          )}
                        </div>
                        <p className="mt-0.5 text-xs text-muted-foreground">{p.description}</p>
                        <p className="mt-0.5 font-mono text-[10px] text-muted-foreground/70">{p.key}</p>
                      </div>
                      <Switch
                        checked={checked}
                        disabled={locked}
                        onCheckedChange={(next) => set(p.key, next)}
                        aria-label={p.label}
                        title={
                          readOnly
                            ? undefined
                            : locked
                              ? 'You can only grant permissions you hold yourself'
                              : undefined
                        }
                      />
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}

export default PermissionGrid;
