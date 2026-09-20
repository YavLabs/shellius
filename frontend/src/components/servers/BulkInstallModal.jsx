import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  Download,
  Loader2,
  Radar,
  ShieldCheck,
  Terminal,
  XCircle,
} from 'lucide-react';
import Modal from '@/components/shared/Modal';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import PasswordInput from '@/components/ui/PasswordInput';
import SearchableSelect from '@/components/ui/SearchableSelect';
import { listCredentials } from '@/services/keystoreService';
import { planBulkInstall, runBulkInstall, createBulkBootstrapTokens } from '@/services/serverService';
import { saveBlob } from '@/utils/download';
import { cn } from '@/lib/utils';

/**
 * Install the collector — or the full agent — across many hosts at once.
 *
 * The single-host wizard is the right shape for a host you just added. It is
 * the wrong shape for an org that has been running Shellius for a year with
 * ninety servers already in inventory: nobody does that ninety times, so the
 * collector never gets installed anywhere and the posture pages stay empty
 * while reporting nothing wrong. That is the failure this exists to prevent.
 *
 * Four steps: review the plan (and above all what it will skip, and why),
 * choose how to authenticate, run, then read the per-host result. The plan
 * comes from the server, so what the UI shows and what the run will do
 * cannot drift.
 */

const SCOPES = [
  {
    value: 'posture',
    icon: Radar,
    title: 'Posture collector only',
    blurb:
      'Adds the collector and its own systemd timer. Does not touch sshd, CA trust or check-principals — safe on hosts that already work.',
  },
  {
    value: 'full',
    icon: ShieldCheck,
    title: 'Full agent',
    blurb:
      'Installs CA trust, check-principals and the agent, so Shellius can issue certificates for these hosts. Reconfigures sshd.',
  },
];

const SKIP_TONE = {
  windows: 'neutral',
  rdp_only: 'neutral',
  inactive: 'neutral',
  already_provisioned: 'success',
  collector_installed: 'success',
  no_credentials: 'warning',
};

function StatusIcon({ status }) {
  if (status === 'ok') return <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />;
  if (status === 'failed') return <XCircle className="h-4 w-4 shrink-0 text-destructive" />;
  if (status === 'running') return <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />;
  return <span className="h-4 w-4 shrink-0 rounded-full border border-border" />;
}

function BulkInstallModal({ open, serverIds = [], onClose, onDone }) {
  const [step, setStep] = useState('plan'); // plan | auth | run | manual
  const [mode, setMode] = useState('posture');
  const [method, setMethod] = useState('auto'); // auto | manual
  const [includeDone, setIncludeDone] = useState(false);

  const [plan, setPlan] = useState(null);
  const [planLoading, setPlanLoading] = useState(false);
  const [error, setError] = useState('');
  const [chosen, setChosen] = useState([]); // target ids actually selected

  // Auth
  const [identities, setIdentities] = useState([]);
  const [credentialId, setCredentialId] = useState('');
  const [sshUser, setSshUser] = useState('');
  const [password, setPassword] = useState('');
  const [sudoPassword, setSudoPassword] = useState('');
  const [useServerIdentity, setUseServerIdentity] = useState(true);
  const [concurrency, setConcurrency] = useState(3);

  // Run
  const [statuses, setStatuses] = useState({}); // id -> {status, error}
  const [logs, setLogs] = useState({}); // id -> [lines]
  const [openLog, setOpenLog] = useState(null);
  const [running, setRunning] = useState(false);
  const [summary, setSummary] = useState(null);
  const runRef = useRef(null);

  // Manual
  const [manual, setManual] = useState(null);
  const [copied, setCopied] = useState(false);

  const reset = useCallback(() => {
    setStep('plan');
    setPlan(null);
    setChosen([]);
    setStatuses({});
    setLogs({});
    setSummary(null);
    setManual(null);
    setError('');
    setRunning(false);
  }, []);

  const loadPlan = useCallback(async () => {
    setPlanLoading(true);
    setError('');
    try {
      const data = await planBulkInstall({
        serverIds,
        mode,
        // The plan has to know whether a fallback exists, or it would skip
        // every host without a bound identity before the user has had the
        // chance to supply one.
        hasFallbackCredentials: true,
        includeDone,
      });
      setPlan(data);
      setChosen(data.targets.map((t) => t.id));
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message || 'Could not build the install plan');
    } finally {
      setPlanLoading(false);
    }
  }, [serverIds, mode, includeDone]);

  useEffect(() => {
    if (!open) return;
    loadPlan();
  }, [open, loadPlan]);

  useEffect(() => {
    if (!open) return;
    listCredentials()
      .then((rows) => setIdentities(Array.isArray(rows) ? rows : rows?.items || []))
      .catch(() => setIdentities([]));
  }, [open]);

  useEffect(() => {
    if (!open) reset();
  }, [open, reset]);

  // Stop the run if the modal goes away — an abandoned bulk install is N
  // unattended SSH sessions, not a background convenience.
  useEffect(() => () => runRef.current?.abort(), []);

  const targets = plan?.targets || [];
  const selectedTargets = targets.filter((t) => chosen.includes(t.id));
  // Hosts that will need the fallback identity, because they have none bound.
  const needingFallback = selectedTargets.filter((t) => !t.credential?.id || !useServerIdentity);
  const fallbackReady = !!(credentialId || password);

  const toggle = (id) =>
    setChosen((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const start = async () => {
    setStep('run');
    setRunning(true);
    setError('');
    setSummary(null);
    setStatuses(Object.fromEntries(selectedTargets.map((t) => [t.id, { status: 'queued' }])));
    setLogs({});

    const append = (id, message) =>
      setLogs((prev) => ({ ...prev, [id]: [...(prev[id] || []), message] }));

    const handle = runBulkInstall(
      {
        serverIds: selectedTargets.map((t) => t.id),
        mode,
        concurrency,
        useServerIdentity,
        credentialId: credentialId || undefined,
        sshUser: sshUser || undefined,
        password: password || undefined,
        sudoPassword: sudoPassword || undefined,
      },
      {
        'server-start': ({ id }) => setStatuses((p) => ({ ...p, [id]: { status: 'running' } })),
        log: ({ id, message }) => append(id, message),
        'server-done': ({ id, status, error: err }) =>
          setStatuses((p) => ({ ...p, [id]: { status, error: err } })),
        done: (s) => setSummary(s),
        error: ({ message }) => setError(message || 'Bulk install failed'),
      }
    );
    runRef.current = handle;

    try {
      await handle.promise;
    } catch (err) {
      if (err.name !== 'AbortError') {
        setError(err.message || 'Bulk install failed');
      }
    } finally {
      setRunning(false);
      runRef.current = null;
      onDone?.();
    }
  };

  const loadManual = async () => {
    setError('');
    try {
      const data = await createBulkBootstrapTokens({
        serverIds: selectedTargets.map((t) => t.id),
        mode,
      });
      setManual(data);
      setStep('manual');
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message || 'Could not mint install commands');
    }
  };

  const manualText = useMemo(
    () =>
      (manual?.items || [])
        .map((i) => `# ${i.displayName || i.hostname}\n${i.command}`)
        .join('\n\n'),
    [manual]
  );

  const skippedByReason = useMemo(() => {
    const by = new Map();
    for (const s of plan?.skipped || []) {
      if (!by.has(s.reason)) by.set(s.reason, { reason: s.reason, message: s.message, rows: [] });
      by.get(s.reason).rows.push(s);
    }
    return [...by.values()];
  }, [plan]);

  const title =
    step === 'run'
      ? running
        ? 'Installing…'
        : 'Install finished'
      : step === 'manual'
        ? 'Install commands'
        : 'Install across multiple hosts';

  const footer = (() => {
    if (step === 'plan') {
      return (
        <div className="flex items-center justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => setStep('auth')} disabled={selectedTargets.length === 0}>
            Continue ({selectedTargets.length})
          </Button>
        </div>
      );
    }
    if (step === 'auth') {
      return (
        <div className="flex items-center justify-end gap-2">
          <Button variant="outline" onClick={() => setStep('plan')}>
            Back
          </Button>
          {method === 'manual' ? (
            <Button onClick={loadManual}>
              <Terminal className="mr-2 h-4 w-4" /> Get commands
            </Button>
          ) : (
            <Button
              onClick={start}
              disabled={needingFallback.length > 0 && !fallbackReady}
              title={
                needingFallback.length > 0 && !fallbackReady
                  ? `${needingFallback.length} of the selected hosts have no saved identity — pick one or enter a password`
                  : undefined
              }
            >
              Install on {selectedTargets.length} host{selectedTargets.length === 1 ? '' : 's'}
            </Button>
          )}
        </div>
      );
    }
    if (step === 'run') {
      return (
        <div className="flex items-center justify-end gap-2">
          {running ? (
            <Button variant="outline" onClick={() => runRef.current?.abort()}>
              Stop
            </Button>
          ) : (
            <Button onClick={onClose}>Close</Button>
          )}
        </div>
      );
    }
    return (
      <div className="flex items-center justify-end gap-2">
        <Button variant="outline" onClick={() => setStep('auth')}>
          Back
        </Button>
        <Button onClick={onClose}>Done</Button>
      </div>
    );
  })();

  return (
    <Modal open={open} onClose={onClose} title={title} size="xl" footer={footer}>
      {error && (
        <div role="alert" className="mb-4 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {step === 'plan' && (
        <div className="space-y-5">
          <section className="space-y-2">
            <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">
              What to install
            </h4>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {SCOPES.map((s) => (
                <button
                  key={s.value}
                  type="button"
                  onClick={() => setMode(s.value)}
                  className={cn(
                    'flex items-start gap-3 rounded-lg border p-3 text-left transition-colors',
                    mode === s.value ? 'border-primary bg-primary/5' : 'border-border hover:bg-accent/40'
                  )}
                >
                  <s.icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-foreground">{s.title}</span>
                    <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">{s.blurb}</span>
                  </span>
                </button>
              ))}
            </div>
          </section>

          {planLoading ? (
            <p className="text-sm text-muted-foreground">Building the plan…</p>
          ) : (
            <>
              <section className="space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                    Will install on {selectedTargets.length} of {targets.length}
                  </h4>
                  {targets.length > 0 && (
                    <button
                      type="button"
                      className="text-xs text-primary hover:underline"
                      onClick={() =>
                        setChosen(chosen.length === targets.length ? [] : targets.map((t) => t.id))
                      }
                    >
                      {chosen.length === targets.length ? 'Clear all' : 'Select all'}
                    </button>
                  )}
                </div>
                {targets.length === 0 ? (
                  <p className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
                    Nothing to install on. Every selected host is already done, or cannot run the
                    installer — see below.
                  </p>
                ) : (
                  <div className="max-h-56 space-y-1 overflow-y-auto rounded-lg border border-border p-2">
                    {targets.map((t) => (
                      <label
                        key={t.id}
                        className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 hover:bg-accent/50"
                      >
                        <Checkbox checked={chosen.includes(t.id)} onChange={() => toggle(t.id)} />
                        <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                          {t.displayName || t.hostname}
                        </span>
                        {t.credential?.id ? (
                          <Badge tone="success" variant="outline">
                            {t.credential.name}
                          </Badge>
                        ) : (
                          <Badge tone="warning" variant="outline">
                            needs credentials
                          </Badge>
                        )}
                      </label>
                    ))}
                  </div>
                )}
              </section>

              {/* The skipped list is the point of showing a plan at all. A
                  silent skip is how you end up believing a fleet is covered. */}
              {skippedByReason.length > 0 && (
                <section className="space-y-2">
                  <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                    Skipping {plan.skipped.length}
                  </h4>
                  <div className="space-y-2">
                    {skippedByReason.map((group) => (
                      <div key={group.reason} className="rounded-lg border border-border px-3 py-2">
                        <div className="flex items-center gap-2">
                          <Badge tone={SKIP_TONE[group.reason] || 'neutral'} variant="outline">
                            {group.rows.length}
                          </Badge>
                          <span className="min-w-0 text-xs text-muted-foreground">{group.message}</span>
                        </div>
                        <p className="mt-1 truncate text-[11px] text-muted-foreground/80">
                          {group.rows.map((r) => r.hostname).join(', ')}
                        </p>
                      </div>
                    ))}
                  </div>
                  {(plan.counts?.staleCollectors > 0 ||
                    plan.skipped.some((s) => s.reason === 'already_provisioned' || s.reason === 'collector_installed')) && (
                    <label className="flex cursor-pointer items-start gap-2 text-xs text-muted-foreground">
                      <Checkbox checked={includeDone} onChange={() => setIncludeDone((v) => !v)} />
                      <span>
                        Re-run on hosts that are already done.
                        {plan.counts?.staleCollectors > 0 && (
                          <span className="text-amber-600 dark:text-amber-400">
                            {' '}
                            {plan.counts.staleCollectors} of them stopped reporting — reinstalling is
                            one way to find out why.
                          </span>
                        )}
                      </span>
                    </label>
                  )}
                </section>
              )}
            </>
          )}
        </div>
      )}

      {step === 'auth' && (
        <div className="space-y-5">
          <section className="space-y-2">
            <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">
              How to install
            </h4>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <button
                type="button"
                onClick={() => setMethod('auto')}
                className={cn(
                  'rounded-lg border p-3 text-left transition-colors',
                  method === 'auto' ? 'border-primary bg-primary/5' : 'border-border hover:bg-accent/40'
                )}
              >
                <span className="block text-sm font-medium text-foreground">Automatically over SSH</span>
                <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
                  Shellius connects to each host and runs the installer. Hosts with a saved identity
                  need nothing from you.
                </span>
              </button>
              <button
                type="button"
                onClick={() => setMethod('manual')}
                className={cn(
                  'rounded-lg border p-3 text-left transition-colors',
                  method === 'manual' ? 'border-primary bg-primary/5' : 'border-border hover:bg-accent/40'
                )}
              >
                <span className="block text-sm font-medium text-foreground">Give me the commands</span>
                <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
                  One command per host, to run yourself or hand to config management.
                </span>
              </button>
            </div>
          </section>

          {method === 'auto' && (
            <>
              <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-border p-3">
                <Checkbox checked={useServerIdentity} onChange={() => setUseServerIdentity((v) => !v)} />
                <span className="min-w-0">
                  <span className="block text-sm text-foreground">
                    Use each host&rsquo;s own saved identity where it has one
                  </span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {plan?.counts?.usingServerIdentity ?? 0} of the selected hosts already carry the
                    identity that reaches them — that identity is exactly what gets us in.
                  </span>
                </span>
              </label>

              {needingFallback.length > 0 && (
                <section className="space-y-3">
                  <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                    Credentials for the remaining {needingFallback.length}
                  </h4>
                  <SearchableSelect
                    value={credentialId}
                    onChange={setCredentialId}
                    options={[
                      { value: '', label: 'No saved identity — enter below' },
                      ...identities.map((c) => ({
                        value: c.id,
                        label: `${c.name}${c.username ? ` (${c.username})` : ''}`,
                      })),
                    ]}
                    placeholder="Saved identity"
                    clearable={false}
                  />
                  {!credentialId && (
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <label className="text-xs text-muted-foreground">
                        SSH user
                        <input
                          value={sshUser}
                          onChange={(e) => setSshUser(e.target.value)}
                          placeholder="e.g. ubuntu"
                          className="mt-1 h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                        />
                      </label>
                      <label className="text-xs text-muted-foreground">
                        Password
                        <PasswordInput
                          value={password}
                          onChange={(e) => setPassword(e.target.value)}
                          className="mt-1 h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                        />
                      </label>
                    </div>
                  )}
                  <label className="text-xs text-muted-foreground">
                    sudo password (if different)
                    <PasswordInput
                      value={sudoPassword}
                      onChange={(e) => setSudoPassword(e.target.value)}
                      className="mt-1 h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                  </label>
                  <p className="text-xs text-muted-foreground">
                    Credentials are used in memory for this run and never stored.
                  </p>
                </section>
              )}

              <label className="flex items-center gap-3 text-xs text-muted-foreground">
                <span className="shrink-0">Hosts at a time</span>
                <SearchableSelect
                  className="w-[90px]"
                  value={String(concurrency)}
                  onChange={(v) => setConcurrency(Number(v))}
                  options={[1, 2, 3, 4, 6, 8].map((n) => ({ value: String(n), label: String(n) }))}
                  searchable={false}
                  clearable={false}
                />
              </label>
            </>
          )}

          {method === 'manual' && (
            <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              Each command carries a single-use token for one host, valid for 30 minutes. Generate
              them when you are ready to run them — a list minted an hour early will not work.
            </p>
          )}
        </div>
      )}

      {step === 'run' && (
        <div className="space-y-3">
          {summary && (
            <div
              className={cn(
                'rounded-md border px-3 py-2 text-sm',
                summary.failed > 0
                  ? 'border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-200'
                  : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-800 dark:text-emerald-200'
              )}
            >
              {summary.ok} succeeded, {summary.failed} failed
              {summary.aborted ? ' (stopped early)' : ''}.
              {summary.failed > 0 && ' Open a failed host below to see why.'}
            </div>
          )}
          <div className="max-h-[22rem] space-y-1 overflow-y-auto rounded-lg border border-border p-2">
            {selectedTargets.map((t) => {
              const st = statuses[t.id] || { status: 'queued' };
              const lines = logs[t.id] || [];
              const isOpen = openLog === t.id;
              return (
                <div key={t.id} className="rounded border border-transparent">
                  <button
                    type="button"
                    onClick={() => setOpenLog(isOpen ? null : t.id)}
                    className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-accent/50"
                  >
                    <StatusIcon status={st.status} />
                    <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                      {t.displayName || t.hostname}
                    </span>
                    {st.error && (
                      <span className="max-w-[14rem] truncate text-xs text-destructive" title={st.error}>
                        {st.error}
                      </span>
                    )}
                    {lines.length > 0 && (
                      <span className="shrink-0 text-[11px] text-muted-foreground">
                        {isOpen ? 'hide' : `${lines.length} lines`}
                      </span>
                    )}
                  </button>
                  {isOpen && lines.length > 0 && (
                    <pre className="mx-2 mb-2 max-h-48 overflow-auto rounded bg-muted/60 p-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
                      {lines.join('\n')}
                    </pre>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {step === 'manual' && manual && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                navigator.clipboard?.writeText(manualText);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              <Copy className="mr-1.5 h-4 w-4" /> {copied ? 'Copied' : 'Copy all'}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                saveBlob(
                  new Blob([`#!/bin/sh\n# Shellius install commands — run each line ON its own host.\n\n${manualText}\n`], {
                    type: 'text/plain',
                  }),
                  'shellius-install-commands.txt'
                )
              }
            >
              <Download className="mr-1.5 h-4 w-4" /> Download
            </Button>
            <span className="text-xs text-muted-foreground">
              {manual.items.length} command{manual.items.length === 1 ? '' : 's'} · expires in{' '}
              {Math.round(manual.expiresInSeconds / 60)} minutes
            </span>
          </div>
          {manual.skipped?.length > 0 && (
            <div className="flex items-start gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <p>
                No command for {manual.skipped.map((s) => s.hostname).join(', ')} — these hosts cannot
                run the installer.
              </p>
            </div>
          )}
          <pre className="max-h-[22rem] overflow-auto rounded-lg border border-border bg-muted/40 p-3 font-mono text-[11px] leading-relaxed text-foreground">
            {manualText}
          </pre>
        </div>
      )}
    </Modal>
  );
}

export default BulkInstallModal;
