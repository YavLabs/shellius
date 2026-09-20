import { AlertTriangle, CheckCircle2, Globe2, Loader2, UsersRound } from 'lucide-react';

/**
 * EffectiveAccessSummary — answers "given the scope + groups I've chosen,
 * what does this user actually end up seeing, and why" (docs/rbac/
 * customer-scope-spec.md §7 phase 4). Purely presentational: UserForm
 * normalizes both the saved `GET /users/:id/effective-scope` response and
 * the client-side pending preview into the same `view` shape below.
 *
 * view: {
 *   kind: 'all' | 'customers',
 *   reason: 'user_all' | 'group_all' | 'union' | 'empty',
 *   allGroups?: { id, name }[]                                    // reason === 'group_all'
 *   customers?: { id, name, viaDirect: bool, viaGroups: string[] }[]  // kind === 'customers'
 * }
 *
 * `live` — true when `view` is an unsaved client-side preview (form has
 * changes not yet saved); false when it's the authoritative saved state
 * fetched from the API.
 */
function EffectiveAccessSummary({ view, live, loading, error }) {
  if (loading) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-border px-3 py-2.5 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading effective access…
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive">
        {error}
      </div>
    );
  }

  if (!view) return null;

  return (
    <div className="space-y-2 rounded-lg border border-border p-3">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Effective access
        </p>
        {live && (
          <span className="rounded-full bg-accent px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
            Preview — not yet saved
          </span>
        )}
      </div>

      {view.kind === 'all' && view.reason === 'user_all' && (
        <div className="flex items-start gap-2 text-sm text-foreground">
          <Globe2 className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <p>This user can see the entire organization — every customer and its servers.</p>
        </div>
      )}

      {view.kind === 'all' && view.reason === 'group_all' && (
        <div className="flex items-start gap-2.5 rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2.5 text-amber-800 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="space-y-0.5">
            <p className="text-sm font-semibold">
              Entire organization — granted by{' '}
              {(view.allGroups || []).map((g) => `“${g.name}”`).join(', ') || 'a group'}
            </p>
            <p className="text-xs text-amber-700/90 dark:text-amber-300/90">
              This user&apos;s own access scope is “Selected customers,” but membership in{' '}
              {(view.allGroups || []).length > 1 ? 'these groups' : 'this group'} overrides that
              and unlocks the entire organization for as long as they&apos;re a member. Remove
              them from {(view.allGroups || []).length > 1 ? 'the groups' : 'the group'} to
              restore their restriction.
            </p>
          </div>
        </div>
      )}

      {view.kind === 'customers' && view.reason === 'union' && (
        <div className="space-y-1.5">
          <div className="flex items-start gap-2 text-sm text-foreground">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            <p>
              This user can see {view.customers.length}{' '}
              {view.customers.length === 1 ? 'customer' : 'customers'} — directly assigned and/or
              granted through their groups.
            </p>
          </div>
          <ul className="ml-6 space-y-1">
            {view.customers.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-1.5 text-xs">
                <span className="font-medium text-foreground">{c.name}</span>
                {c.viaDirect && (
                  <span className="rounded-full bg-accent px-1.5 py-0.5 text-[10px] text-muted-foreground">
                    Direct
                  </span>
                )}
                {c.viaGroups.map((gName) => (
                  <span
                    key={gName}
                    className="flex items-center gap-1 rounded-full bg-accent px-1.5 py-0.5 text-[10px] text-muted-foreground"
                  >
                    <UsersRound className="h-2.5 w-2.5" /> {gName}
                  </span>
                ))}
              </li>
            ))}
          </ul>
        </div>
      )}

      {view.kind === 'customers' && view.reason === 'empty' && (
        <div className="flex items-start gap-2.5 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2.5 text-destructive">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <p className="text-sm font-medium">
            This user will see NOTHING — no customers are assigned directly, and none of their
            groups grant any either. They won&apos;t be able to see any customer or server until
            you assign a customer or add them to a group that does.
          </p>
        </div>
      )}
    </div>
  );
}

export default EffectiveAccessSummary;
