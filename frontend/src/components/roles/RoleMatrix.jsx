import { Fragment, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, Check, Download, Minus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SwitchField } from '@/components/ui/switch';
import { cn } from '@/lib/utils';

/**
 * RoleMatrix — every permission (rows) × every role (columns), grouped by
 * area. Read-only overview; click a role to edit it. "Only differences"
 * hides rows where every role agrees. Export gives the same grid as CSV.
 */
function RoleMatrix({ catalog, roles }) {
  const [onlyDiff, setOnlyDiff] = useState(false);
  const sets = useMemo(() => roles.map((r) => new Set(r.permissions)), [roles]);

  const rowsFor = (group) =>
    catalog.permissions
      .filter((p) => p.group === group.key)
      .filter((p) => {
        if (!onlyDiff) return true;
        const vals = sets.map((s) => s.has(p.key));
        return vals.some((v) => v !== vals[0]);
      });

  const exportCsv = () => {
    const esc = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    const header = ['permission', 'area', 'label', 'sensitive', ...roles.map((r) => r.name)];
    const groupLabel = Object.fromEntries(catalog.groups.map((g) => [g.key, g.label]));
    const lines = [header, ...catalog.permissions.map((p) => [p.key, groupLabel[p.group], p.label, p.sensitive ? 'yes' : '', ...sets.map((s) => (s.has(p.key) ? 'Y' : 'N'))])];
    const blob = new Blob([lines.map((l) => l.map(esc).join(',')).join('\n') + '\n'], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'shellius-role-matrix.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SwitchField
          className="min-h-10 min-w-0 flex-1 sm:max-w-md"
          size="sm"
          label="Only show permissions where roles differ"
          checked={onlyDiff}
          onCheckedChange={setOnlyDiff}
        />
        <Button variant="outline" size="sm" onClick={exportCsv}>
          <Download className="mr-1.5 h-3.5 w-3.5" /> Export CSV
        </Button>
      </div>
      {/* Mobile: per-permission list grouped by area; each row lists the roles holding it. */}
      <div className="space-y-4 md:hidden">
        <div className="flex flex-wrap gap-1.5">
          {roles.map((r) => (
            <Link
              key={r.id}
              to={`/admin/roles/${r.id}`}
              className="inline-flex h-9 items-center gap-1.5 rounded-full border border-border bg-card px-3 text-xs font-medium text-foreground hover:border-primary/50"
            >
              {r.name}
              <span className="tabular-nums text-muted-foreground">{r.permissions.length}</span>
            </Link>
          ))}
        </div>
        {catalog.groups.map((g) => {
          const rows = rowsFor(g);
          if (rows.length === 0) return null;
          return (
            <section key={g.key}>
              <h3 className="mb-1.5 px-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{g.label}</h3>
              <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
                {rows.map((p) => {
                  const holders = roles.filter((_, i) => sets[i].has(p.key));
                  return (
                    <li key={p.key} className="px-3 py-2.5">
                      <div className="flex items-start gap-1.5 text-sm text-foreground">
                        <span className="min-w-0 break-words">{p.label}</span>
                        {p.sensitive && <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" aria-label="Sensitive" />}
                      </div>
                      {p.description && <p className="mt-0.5 text-xs text-muted-foreground">{p.description}</p>}
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {roles.map((r, i) =>
                          sets[i].has(p.key) ? (
                            <span
                              key={r.id}
                              className="inline-flex items-center gap-1 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-400"
                            >
                              <Check className="h-3 w-3" aria-hidden="true" />
                              {r.name}
                            </span>
                          ) : null
                        )}
                        {holders.length === 0 && <span className="text-[11px] text-muted-foreground">No role</span>}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </div>

      <div className="hidden overflow-x-auto rounded-lg border border-border bg-card md:block">
        <table className="w-full min-w-[640px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/30">
              <th className="sticky left-0 z-10 min-w-[240px] bg-card px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">
                Permission
              </th>
              {roles.map((r) => (
                <th key={r.id} className="px-3 py-2.5 text-center text-xs font-medium">
                  <Link to={`/admin/roles/${r.id}`} className="text-foreground hover:text-primary hover:underline">
                    {r.name}
                  </Link>
                  <div className="font-normal tabular-nums text-muted-foreground">{r.permissions.length}</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {catalog.groups.map((g) => {
              const rows = rowsFor(g);
              if (rows.length === 0) return null;
              return (
                <Fragment key={g.key}>
                  <tr className="border-b border-border bg-muted/20">
                    <td colSpan={roles.length + 1} className="sticky left-0 px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                      {g.label}
                    </td>
                  </tr>
                  {rows.map((p) => (
                    <tr key={p.key} className="border-b border-border last:border-0 hover:bg-accent/30">
                      <td className="sticky left-0 z-10 bg-card px-4 py-2" title={p.description}>
                        <span className="flex items-center gap-1.5 text-foreground">
                          {p.label}
                          {p.sensitive && <AlertTriangle className="h-3 w-3 shrink-0 text-amber-500" aria-label="Sensitive" />}
                        </span>
                      </td>
                      {sets.map((s, i) => (
                        <td key={roles[i].id} className="px-3 py-2 text-center">
                          {s.has(p.key) ? (
                            <Check className="mx-auto h-4 w-4 text-emerald-600 dark:text-emerald-400" aria-label="Yes" />
                          ) : (
                            <Minus className={cn('mx-auto h-4 w-4 text-muted-foreground/40')} aria-label="No" />
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default RoleMatrix;
