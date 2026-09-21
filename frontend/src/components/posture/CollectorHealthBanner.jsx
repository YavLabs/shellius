import { useState } from 'react';
import { AlertTriangle, ChevronDown, Info, Loader2, RefreshCw, ShieldOff, TerminalSquare, Ban } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/settings/shared';
import { HOST_CHECK_COMMANDS, explainDegraded, isOlderVersion } from '@/lib/collectorHealth';
import { relativeTime, formatDateTime } from '@/utils/time';

/**
 * What is wrong with this host's collector, what it means, and the button
 * that fixes it.
 *
 * It used to be a red box with the collector's raw reason and nothing to
 * click — the reader learned that something was wrong and had to work out
 * alone what, and where to go to fix it. Every state now says what it means
 * for the data on the page, and offers the action that addresses it:
 * reinstalling the collector (the fix for most of them), or the commands to
 * run on the host when a reinstall would not help.
 */

const TONES = {
  danger: 'border-destructive/50 bg-destructive/10 text-destructive',
  warning: 'border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-200',
  info: 'border-border bg-muted/40 text-foreground',
};

function HostChecks() {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="inline-flex items-center gap-1 text-xs font-medium underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
      >
        <TerminalSquare className="h-3.5 w-3.5" />
        {open ? 'Hide host checks' : 'Check on the host'}
        <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <ul className="mt-2 space-y-2">
          {HOST_CHECK_COMMANDS.map((c) => (
            <li key={c.command}>
              <p className="text-[11px] opacity-80">{c.label}</p>
              <div className="mt-0.5 flex items-center rounded border border-border bg-background/70 px-2 py-1">
                <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-[11px] text-foreground">
                  {c.command}
                </code>
                <CopyButton text={c.command} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Shell({ tone, icon: Icon, title, children, action }) {
  return (
    <div role="status" className={`rounded-md border px-3 py-2.5 text-sm ${TONES[tone]}`}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <div className="flex min-w-0 flex-1 items-start gap-2">
          <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p className="font-medium">{title}</p>
            <div className="mt-0.5 space-y-1 text-xs opacity-90">{children}</div>
          </div>
        </div>
        {action && <div className="shrink-0 max-sm:[&>*]:w-full">{action}</div>}
      </div>
    </div>
  );
}

/**
 * @param {object} props
 * @param {string} props.state        collector state (see lib/collectorHealth collectorStateOf)
 * @param {object} props.collector    API `collector` block
 * @param {object} props.snapshot     API `snapshot` block
 * @param {Function} [props.onReinstall]  opens the installer; omitted when the viewer cannot run it
 */
export default function CollectorHealthBanner({ state, collector, snapshot, onReinstall }) {
  const reinstallButton = (label = 'Reinstall collector') =>
    onReinstall ? (
      <Button size="sm" variant="outline" onClick={onReinstall} className="bg-background">
        <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
        {label}
      </Button>
    ) : null;
  const noPermissionHint = !onReinstall ? (
    <p className="italic">Ask someone who can onboard servers to reinstall the collector.</p>
  ) : null;

  // Which collector said all this, and when — a warning from a collector
  // that has since been replaced reads very differently.
  const provenance = collector?.version ? (
    <p className="opacity-80">
      Reported by collector {collector.version}
      {collector.lastSeenAt ? `, ${relativeTime(collector.lastSeenAt)}` : ''}.
      {isOlderVersion(collector.version, collector.latestVersion) &&
        ` Version ${collector.latestVersion} is available and may already fix some of this.`}
    </p>
  ) : null;

  if (state === 'awaiting_report') {
    return (
      <Shell tone="info" icon={Loader2} title="Collector reinstalled — waiting for its first report">
        <p>
          Installed {relativeTime(collector?.installedAt)}. The new collector reports within a minute or two; this page
          updates when it does.
        </p>
        {collector?.lastSeenAt && (
          <p>
            What is shown below is the last report from the collector it replaced
            {collector.version ? ` (${collector.version})` : ''}, {relativeTime(collector.lastSeenAt)} — not the current state.
          </p>
        )}
        <HostChecks />
      </Shell>
    );
  }

  if (state === 'rejected') {
    return (
      <Shell tone="danger" icon={Ban} title="Shellius is refusing this host’s reports" action={reinstallButton('Update collector')}>
        <p>
          The collector is running and sending snapshots, but the latest one ({relativeTime(collector?.rejection?.at)}) did not
          pass the API’s checks, so nothing below has been updated since{' '}
          {collector?.lastSeenAt ? relativeTime(collector.lastSeenAt) : 'it was installed'}.
        </p>
        {collector?.rejection?.reason && (
          <p className="break-words font-mono text-[11px]">{collector.rejection.reason}</p>
        )}
        <p>
          This is usually a collector older or newer than this Shellius. Updating it installs the version this server expects.
        </p>
        {noPermissionHint}
        <HostChecks />
      </Shell>
    );
  }

  if (state === 'stale') {
    return (
      <Shell tone="warning" icon={AlertTriangle} title="This host stopped reporting" action={reinstallButton()}>
        <p>
          Last snapshot {relativeTime(collector?.lastSeenAt)} ({formatDateTime(collector?.lastSeenAt)}). Findings below are held at
          their last known state, not cleared.
        </p>
        <p>
          Usual causes: the host is off or cannot reach Shellius, the collector’s timer stopped, or its agent token was replaced.
          Reinstalling restarts the timer and re-issues the token; if the host is unreachable, fix that first.
        </p>
        {noPermissionHint}
        <HostChecks />
      </Shell>
    );
  }

  if (state === 'degraded') {
    const reasons = snapshot?.degradedReasons?.length ? snapshot.degradedReasons : [snapshot?.degradedReason].filter(Boolean);
    const { items, reinstallHelps, onlyInformational } = explainDegraded(reasons);
    return (
      <Shell
        tone={onlyInformational ? 'info' : 'danger'}
        icon={onlyInformational ? Info : ShieldOff}
        title={onlyInformational ? 'The collector is reporting, with notes' : 'Collector degraded — this report is incomplete'}
        action={reinstallHelps ? reinstallButton() : null}
      >
        {!onlyInformational && (
          <p>It ran, but could not see everything. Treat “no findings” here as unverified, not clean.</p>
        )}
        {provenance}
        {items.length === 0 && <p>The collector did not say why.</p>}
        <ul className="mt-1 space-y-2">
          {items.map((item) => (
            <li key={item.key} className="rounded border border-border/60 bg-background/40 px-2 py-1.5">
              <p className="font-medium">{item.title}</p>
              <p className="mt-0.5">{item.explain}</p>
              <p className="mt-0.5">
                <span className="font-medium">What to do: </span>
                {item.fix}
              </p>
              {item.raw !== item.explain && (
                <details className="mt-1">
                  <summary className="cursor-pointer text-[11px] opacity-80">What the collector said</summary>
                  <p className="mt-0.5 break-words font-mono text-[11px]">{item.raw}</p>
                </details>
              )}
            </li>
          ))}
        </ul>
        {reinstallHelps && noPermissionHint}
        {!onlyInformational && <HostChecks />}
      </Shell>
    );
  }

  // Reporting fine, but with notes about what this host does not let it
  // see. Not a problem to fix — said once, quietly.
  const notes = snapshot?.notes || [];
  if ((state === 'reporting' || state === 'outdated') && notes.length > 0) {
    const { items } = explainDegraded(notes);
    return (
      <Shell tone="info" icon={Info} title="Reporting, with notes">
        <ul className="space-y-1">
          {items.map((item) => (
            <li key={item.key}>
              <span className="font-medium">{item.title}.</span> {item.explain}
            </li>
          ))}
        </ul>
      </Shell>
    );
  }

  return null;
}
