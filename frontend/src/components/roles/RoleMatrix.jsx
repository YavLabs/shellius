import { Fragment, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, Check, Download, Minus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <Checkbox checked={onlyDiff} onChange={(e) => setOnlyDiff(e.target.checked)} />
          Only show permissions where roles differ
        </label>
        <Button variant="outline" size="sm" onClick={exportCsv}>
          <Download className="mr-1.5 h-3.5 w-3.5" /> Export CSV
        </Button>
      </div>
      <div className="overflow-x-auto rounded-lg border border-border bg-card">
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
