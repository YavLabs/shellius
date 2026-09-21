import { useState } from 'react';
import { Download, KeyRound, ServerOff, ShieldCheck, Sparkles } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import FindingSection from '@/components/posture/FindingSection';
import { groupPlan, targetsByCredentialSource, CREDENTIAL_SOURCE } from '@/lib/installPlan';
import { relativeTime } from '@/utils/time';
import { cn } from '@/lib/utils';

/**
 * The bulk-install plan, grouped by what can actually be done about it.
 *
 * A flat list of "hosts with no collector" is not useful, because the
 * reasons a host is on it are not the same kind of thing. One needs a
 * password; one is a Windows box that will never run the collector; one is
 * fine already. Showing them together produces a number that looks like a
 * backlog and cannot be worked down.
 *
 * So: one section per answer, counts on every section so nothing is hidden
 * behind a tab, and only the actionable section carries checkboxes. Sections
 * that are not work stay collapsed.
 *
 * Shared by the installer and the coverage modal so the two cannot disagree
 * about what is installable.
 */

const SOURCE_ICON = {
  server: KeyRound,
  certificate: ShieldCheck,
  supplied: Sparkles,
};

/** One host, as a row. Same shape everywhere a host is listed here. */
function HostRow({ host, children, className }) {
  return (
    <div className={cn('flex min-w-0 items-center gap-2 rounded px-2 py-1.5', className)}>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-foreground">{host.displayName || host.hostname}</span>
        <span className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 text-[11px] text-muted-foreground">
          {host.customer?.name && <span className="truncate">{host.customer.name}</span>}
          {host.environment && (
            <>
              <span aria-hidden="true">·</span>
              <span className="uppercase">{host.environment}</span>
            </>
          )}
          {host.lastSnapshotAt && (
            <>
              <span aria-hidden="true">·</span>
              <span>last report {relativeTime(host.lastSnapshotAt)}</span>
            </>
          )}
        </span>
      </span>
      {children}
    </div>
  );
}

/** The actionable section: hosts split by how each will authenticate. */
function ReadyGroup({ rows, selectedIds, onToggle, selectable, onInstallHost }) {
  const bySource = targetsByCredentialSource(rows);
  return (
    <div className="space-y-4">
      {bySource.map((group) => {
        const Icon = SOURCE_ICON[group.key] || KeyRound;
        return (
          <div key={group.key} className="space-y-1.5">
            <div className="flex items-start gap-2">
              <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <div className="min-w-0">
                <p className="text-xs font-medium text-foreground">
                  {group.label}
                  <span className="ml-1.5 text-muted-foreground tabular-nums">{group.rows.length}</span>
                </p>
                <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">{group.hint}</p>
              </div>
            </div>
            <div className="space-y-0.5 rounded-lg border border-border p-1.5">
              {group.rows.map((host) =>
                selectable ? (
                  <label
                    key={host.id}
                    className="flex cursor-pointer items-center gap-2 rounded pl-2 hover:bg-accent/50"
                  >
                    <Checkbox
                      checked={selectedIds.includes(host.id)}
                      onChange={() => onToggle(host.id)}
                    />
                    <HostRow host={host} className="flex-1" />
                  </label>
                ) : (
                  <HostRow key={host.id} host={host}>
                    {/* "Install on just this one" stays reachable — the
                        grouped view replaced a flat list that had a
                        per-host button, and dropping it would be a
                        capability lost to a layout change. */}
                    {onInstallHost && (
                      <button
                        type="button"
                        onClick={() => onInstallHost(host)}
                        className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-border px-2.5 text-xs text-foreground transition-colors hover:bg-accent"
                      >
                        <Download className="h-3.5 w-3.5" aria-hidden="true" />
                        Install
                      </button>
                    )}
                  </HostRow>
                )
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function InstallPlanGroups({
  plan,
  selectable = false,
  selectedIds = [],
  onToggle,
  onSelectAll,
  onInstallHost,
  footerFor,
}) {
  const groups = groupPlan(plan);
  // Only the section that is work opens by itself. The rest are reference.
  const [open, setOpen] = useState({ ready: true });
  const toggleOpen = (key) => setOpen((p) => ({ ...p, [key]: !p[key] }));

  return (
    <div className="space-y-2">
      {groups.map((group) => (
        <FindingSection
          key={group.key}
          title={group.title}
          description={group.description}
          count={group.rows.length}
          tone={group.tone}
          open={!!open[group.key]}
          onToggle={() => toggleOpen(group.key)}
        >
          {group.key === 'ready' ? (
            <>
              {selectable && group.rows.length > 1 && (
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="text-xs text-muted-foreground">
                    {selectedIds.length} of {group.rows.length} selected
                  </span>
                  <button
                    type="button"
                    className="text-xs font-medium text-[hsl(var(--brand))] hover:underline"
                    onClick={onSelectAll}
                  >
                    {selectedIds.length === group.rows.length ? 'Clear all' : 'Select all'}
                  </button>
                </div>
              )}
              <ReadyGroup
                rows={group.rows}
                selectedIds={selectedIds}
                onToggle={onToggle}
                selectable={selectable}
                onInstallHost={onInstallHost}
              />
            </>
          ) : (
            <div className="space-y-0.5">
              {group.rows.map((host) => (
                <HostRow key={host.id} host={host}>
                  {group.key === 'not_applicable' && (
                    <Badge tone="neutral" variant="outline">
                      {host.reason === 'windows'
                        ? 'Windows'
                        : host.reason === 'rdp_only'
                          ? 'RDP only'
                          : 'Inactive'}
                    </Badge>
                  )}
                  {group.key === 'ready' && (
                    <Badge tone="neutral" variant="outline">
                      {CREDENTIAL_SOURCE[host.credentialSource]?.label}
                    </Badge>
                  )}
                </HostRow>
              ))}
            </div>
          )}
          {footerFor?.(group)}
        </FindingSection>
      ))}
      {groups.every((g) => g.rows.length === 0) && (
        <p className="flex items-center gap-2 rounded-lg border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
          <ServerOff className="h-4 w-4" aria-hidden="true" />
          No servers in scope.
        </p>
      )}
    </div>
  );
}

export default InstallPlanGroups;
