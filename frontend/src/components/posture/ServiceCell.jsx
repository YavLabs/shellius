import { describeListener } from '@/lib/serviceIdentity';
import { cn } from '@/lib/utils';

/**
 * What is listening on a port, as one readable cell: the service's name,
 * a runtime chip (systemd / Docker / pm2 / …), the recognised protocol when
 * it adds something, and where it is defined underneath.
 *
 * Replaces three columns (Service / Owner / Source) that showed raw
 * collector strings like `systemd/mysql.service` and `docker-proxy/docker-proxy`.
 */

const RUNTIME_TONES = {
  systemd: 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300',
  'systemd-user': 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300',
  docker: 'border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300',
  podman: 'border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300',
  pm2: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  process: 'border-border bg-muted text-muted-foreground',
  unknown: 'border-border bg-muted text-muted-foreground',
};

export function RuntimeChip({ runtime, className }) {
  if (!runtime) return null;
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded border px-1.5 py-px text-[10px] font-medium leading-4',
        RUNTIME_TONES[runtime.key] || RUNTIME_TONES.unknown,
        className
      )}
    >
      {runtime.label}
    </span>
  );
}

/** Tooltip text: every raw fact, for the reader who needs it. */
function tooltipFor(d) {
  return [
    `${d.name} (${d.runtime.label})`,
    d.protocol && `Service: ${d.protocol}`,
    d.id && `ID: ${d.id}`,
    d.details.user && `User: ${d.details.user}`,
    d.details.pid && `PID: ${d.details.pid}`,
    d.details.command && `Command: ${d.details.command}`,
    d.details.source && `Defined in: ${d.details.source}`,
  ]
    .filter(Boolean)
    .join('\n');
}

export default function ServiceCell({ listener, className, showRuntime = false }) {
  const d = describeListener(listener);
  return (
    <div className={cn('min-w-0 max-w-[26rem]', className)} title={tooltipFor(d)}>
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="truncate text-sm font-medium text-foreground">{d.name}</span>
        {showRuntime && <RuntimeChip runtime={d.runtime} />}
        {d.protocol && (
          <span className="inline-flex shrink-0 items-center rounded border border-border px-1.5 py-px text-[10px] leading-4 text-muted-foreground">
            {d.protocol}
          </span>
        )}
      </div>
      {d.subtext && <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">{d.subtext}</p>}
    </div>
  );
}
