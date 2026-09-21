import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  Download,
  KeyRound,
  Loader2,
  MinusCircle,
  Radar,
  ShieldCheck,
  Terminal,
  XCircle,
} from 'lucide-react';
import Modal from '@/components/shared/Modal';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import PasswordInput from '@/components/ui/PasswordInput';
import SearchableSelect from '@/components/ui/SearchableSelect';
import { listCredentials } from '@/services/keystoreService';
import {
  planBulkInstall,
  provisionServer,
  runBulkInstall,
  createBulkBootstrapTokens,
} from '@/services/serverService';
import { saveBlob } from '@/utils/download';
import InstallPlanGroups from '@/components/posture/InstallPlanGroups';
import { defaultSelection, selectableHosts } from '@/lib/installPlan';
import { useAuth } from '@/context/AuthContext';
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


// Mirror backend provisionService: no sudo password given / the one given was refused.
const SUDO_PASSWORD_REQUIRED = 'SUDO_PASSWORD_REQUIRED';
const SUDO_PASSWORD_INCORRECT = 'SUDO_PASSWORD_INCORRECT';
const isSudoCode = (code) => code === SUDO_PASSWORD_REQUIRED || code === SUDO_PASSWORD_INCORRECT;

function StatusIcon({ status }) {
  if (status === 'ok') return <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />;
  if (status === 'failed') return <XCircle className="h-4 w-4 shrink-0 text-destructive" />;
  // Never installed, never failed — the run ended first.
  if (status === 'stopped') return <MinusCircle className="h-4 w-4 shrink-0 text-muted-foreground" />;
  if (status === 'running') return <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />;
  return <span className="h-4 w-4 shrink-0 rounded-full border border-border" />;
}

function BulkInstallModal({ open, serverIds = [], onClose, onDone }) {
  const [step, setStep] = useState('plan'); // plan | auth | run | manual
  const [mode, setMode] = useState('posture');
  const [method, setMethod] = useState('auto'); // auto | manual
  const { can } = useAuth();
  // Saving a sudo password binds a secret to a server and creates a Keystore
  // entry — both permissions, same as the backend checks.
  const canSaveSudo = can('servers.manage_credentials') && can('keystore.manage');
  const [rememberSudo, setRememberSudo] = useState(true);

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
  // Set when the operator presses Stop, so the sweep below can say "stopped"
  // rather than "no result" — different things, and the person who pressed
  // the button knows which one they caused.
  const stoppedRef = useRef(false);
  // Per-host sudo passwords, typed after the run reported that this host
  // wants one. Never sent anywhere but that host's own retry.
  const [sudoFixes, setSudoFixes] = useState({}); // id -> password
  const [retrying, setRetrying] = useState({}); // id -> bool

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
        // Already-done hosts come back as their own groups either way and
        // are selectable one by one — see defaultSelection().
        includeDone: false,
      });
      setPlan(data);
      setChosen(defaultSelection(data));
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message || 'Could not build the install plan');
    } finally {
      setPlanLoading(false);
    }
  }, [serverIds, mode]);

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

  // Ready hosts and any already-done host ticked for a re-run.
  const selectable = selectableHosts(plan);
  const selectedTargets = selectable.filter((t) => chosen.includes(t.id));
  const reinstallCount = selectedTargets.filter((t) => t.alreadyDone).length;
  // Who will need `sudo` to answer with a password: a non-root login. Those
  // with a saved sudo password need nothing typed.
  const nonRoot = selectedTargets.filter((t) => (t.sshUser || sshUser || 'root') !== 'root');
  const nonRootSaved = nonRoot.filter((t) => t.savedSudo).length;
  // Hosts that will need the fallback identity — i.e. the ones the plan
  // could not authenticate on its own. A certificate host never does: it is
  // already bootstrapped, so Shellius signs its way in. Getting this wrong
  // is what made the wizard demand a password for a fleet that needed none.
  const needingFallback = selectedTargets.filter(
    (t) => t.credentialSource === 'supplied' || (!useServerIdentity && t.credentialSource === 'server')
  );
  const certCount = selectedTargets.filter((t) => t.credentialSource === 'certificate').length;
  const tally = useMemo(() => {
    const t = { ok: 0, failed: 0, needsSudo: 0, stopped: 0 };
    for (const v of Object.values(statuses)) {
      if (v.status === 'ok') t.ok += 1;
      else if (v.status === 'stopped') t.stopped += 1;
      else if (v.status === 'failed' && isSudoCode(v.code)) t.needsSudo += 1;
      else if (v.status === 'failed') t.failed += 1;
    }
    return t;
  }, [statuses]);
  const fallbackReady = !!(credentialId || password);

  const toggle = (id) =>
    setChosen((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  const setMany = (ids, on) =>
    setChosen((prev) => (on ? [...new Set([...prev, ...ids])] : prev.filter((x) => !ids.includes(x))));

  const start = async () => {
    setStep('run');
    stoppedRef.current = false;
    setSudoFixes({});
    setRetrying({});
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
        rememberSudoPassword: !!sudoPassword && canSaveSudo && rememberSudo,
      },
      {
        'server-start': ({ id }) => setStatuses((p) => ({ ...p, [id]: { status: 'running' } })),
        log: ({ id, message }) => append(id, message),
        'server-done': ({ id, status, error: err, code, sudoSaved }) =>
          setStatuses((p) => ({ ...p, [id]: { status, error: err, code, sudoSaved: !!sudoSaved } })),
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
      // Anything still queued or running when the stream ends never reported
      // a result and never will — the request is gone. Leaving those rows
      // spinning under a heading that says "Install finished" is the UI
      // telling two contradictory stories about the same host, and it is
      // what a stopped run used to look like forever.
      setStatuses((prev) => {
        const next = { ...prev };
        for (const [id, entry] of Object.entries(next)) {
          if (entry.status === 'queued' || entry.status === 'running') {
            next[id] = {
              status: 'stopped',
              error: stoppedRef.current
                ? 'Stopped before this host finished.'
                : 'The run ended before this host reported a result.',
            };
          }
        }
        return next;
      });
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

  /**
   * Re-run one host with the sudo password just typed for it.
   *
   * Reuses the single-host provision endpoint rather than re-running the
   * batch: the other hosts already succeeded, and a bulk re-run would
   * reinstall on all of them to fix one.
   */
  const retryWithSudo = async (target, secretOverride) => {
    const secret = secretOverride ?? sudoFixes[target.id];
    if (!secret) return;
    setRetrying((p) => ({ ...p, [target.id]: true }));
    setStatuses((p) => ({ ...p, [target.id]: { status: 'running' } }));
    setLogs((p) => ({ ...p, [target.id]: [...(p[target.id] || []), '[shellius] Retrying with the sudo password you supplied'] }));
    try {
      const result = await provisionServer(target.id, {
        mode,
        sudoPassword: secret,
        // Kept only if this install succeeds with it — see the backend.
        rememberSudoPassword: canSaveSudo && rememberSudo,
        // Same way in as the batch used for this host.
        useCertificate: target.credentialSource === 'certificate' || undefined,
        credentialId: target.credentialSource === 'server' ? target.credential?.id : credentialId || undefined,
        sshUser: target.sshUser || sshUser || undefined,
        password: target.credentialSource === 'supplied' ? password || undefined : undefined,
        onLog: (message) =>
          setLogs((p) => ({ ...p, [target.id]: [...(p[target.id] || []), message] })),
      });
      setStatuses((p) => ({ ...p, [target.id]: { status: 'ok', sudoSaved: !!result?.sudoSaved } }));
      // The password has done its job; do not keep it in component state.
      setSudoFixes((p) => {
        const next = { ...p };
        delete next[target.id];
        return next;
      });
      onDone?.();
    } catch (err) {
      setStatuses((p) => ({
        ...p,
        [target.id]: { status: 'failed', error: err?.message || 'Install failed', code: err?.code || p[target.id]?.code },
      }));
    } finally {
      setRetrying((p) => ({ ...p, [target.id]: false }));
    }
  };

  /** One password for every host still waiting on sudo — they often share it. */
  const retryAllWaiting = async (secret) => {
    const waiting = selectedTargets.filter((t) => {
      const st = statuses[t.id];
      return st?.status === 'failed' && isSudoCode(st.code) && !retrying[t.id];
    });
    for (const t of waiting) {
      // Sequential on purpose: a wrong password fails fast, and N parallel
      // sudo failures on N hosts is N audit-log lines about one typo.
      await retryWithSudo(t, secret);
    }
  };

  const title =
    step === 'run'
      ? running
        ? 'Installing…'
        : stoppedRef.current
          ? 'Install stopped'
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
            <Button
              variant="outline"
              onClick={() => {
                stoppedRef.current = true;
                runRef.current?.abort();
              }}
            >
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
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                    {selectedTargets.length} selected
                    {reinstallCount > 0 && (
                      <span className="ml-1 normal-case tracking-normal">
                        · {selectedTargets.length - reinstallCount} new, {reinstallCount} reinstall
                      </span>
                    )}
                  </h4>
                  {plan?.counts?.total > 0 && (
                    <span className="text-[11px] text-muted-foreground">
                      {plan.counts.total} host{plan.counts.total === 1 ? '' : 's'} in scope
                    </span>
                  )}
                </div>

                {/* Grouped by what can be done about each host, not by a
                    single flat "not installed" number that mixes a missing
                    password with a Windows box. Same grouping as the
                    coverage list, from the same plan. */}
                <InstallPlanGroups
                  plan={plan}
                  selectable
                  selectedIds={chosen}
                  onToggle={toggle}
                  onSetMany={setMany}
                  footerFor={(group) =>
                    group.key === 'needs_credentials' && group.rows.length > 0 ? (
                      <p className="mt-3 rounded-md bg-muted/50 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
                        Two ways to fix this permanently: bind an identity to each host from its
                        Server Details page, or re-run a bulk import with{' '}
                        <code className="font-mono">storeAsIdentity</code> set, which saves the
                        credentials it was given to the Keystore instead of discarding them.
                      </p>
                    ) : null
                  }
                />
              </section>
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
              {/* Say up front what, if anything, is actually needed. The
                  wizard used to ask for a password on every run, including
                  runs where not one host would have used it. */}
              <div
                className={cn(
                  'rounded-lg border px-3 py-2.5 text-xs leading-relaxed',
                  needingFallback.length === 0
                    ? 'border-emerald-500/30 bg-emerald-500/5 text-foreground'
                    : 'border-border bg-muted/40 text-muted-foreground'
                )}
              >
                {needingFallback.length === 0 ? (
                  <span className="flex items-start gap-2">
                    <ShieldCheck
                      className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400"
                      aria-hidden="true"
                    />
                    <span>
                      <span className="font-medium">Nothing needed from you.</span> All{' '}
                      {selectedTargets.length} selected host
                      {selectedTargets.length === 1 ? '' : 's'} can be reached with what Shellius
                      already has
                      {certCount > 0 && (
                        <>
                          {' '}
                          — {certCount} of them via a short-lived certificate, because they are
                          already bootstrapped and trust the certificate authority
                        </>
                      )}
                      .
                    </span>
                  </span>
                ) : (
                  <span>
                    {selectedTargets.length - needingFallback.length} of {selectedTargets.length}{' '}
                    selected host{selectedTargets.length === 1 ? '' : 's'} need nothing from you
                    {certCount > 0 && ` (${certCount} via a short-lived certificate)`}. The
                    remaining {needingFallback.length} need credentials below.
                  </span>
                )}
              </div>

              <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-border p-3">
                <Checkbox checked={useServerIdentity} onChange={() => setUseServerIdentity((v) => !v)} />
                <span className="min-w-0">
                  <span className="block text-sm text-foreground">
                    Use each host&rsquo;s own saved identity where it has one
                  </span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {plan?.counts?.usingServerIdentity ?? 0} of the hosts in this plan already carry
                    the identity that reaches them. Turning this off uses the credentials below on
                    every host instead — certificate hosts are unaffected either way.
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
                  <p className="text-xs text-muted-foreground">
                    Credentials are used in memory for this run and never stored.
                  </p>
                </section>
              )}

              {/* sudo: asked once, up front, for every host that could need
                  it — not only in the "credentials" section, which a fleet
                  of certificate hosts never sees, and not host by host after
                  the run has already failed on each of them. */}
              {nonRoot.length > 0 && (
                <section className="space-y-2 rounded-lg border border-border p-3">
                  <h4 className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                    <KeyRound className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                    sudo password <span className="font-normal text-muted-foreground">(optional)</span>
                  </h4>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    {nonRoot.length} selected host{nonRoot.length === 1 ? '' : 's'} log in as a non-root user.
                    {nonRootSaved > 0 &&
                      ` ${nonRootSaved} ${nonRootSaved === 1 ? 'has' : 'have'} a saved sudo password and need nothing.`}{' '}
                    If the others’ sudo asks for a password, enter it here; hosts with passwordless sudo ignore it. Leave it
                    empty and any host that needs one stops and asks — you can answer it there.
                  </p>
                  <PasswordInput
                    value={sudoPassword}
                    onChange={(e) => setSudoPassword(e.target.value)}
                    placeholder="sudo password"
                    autoComplete="new-password"
                    className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                  {canSaveSudo && sudoPassword && (
                    <label className="flex cursor-pointer items-start gap-2 text-xs text-muted-foreground">
                      <Checkbox checked={rememberSudo} onChange={(e) => setRememberSudo(e.target.checked)} className="mt-0.5" />
                      <span>
                        <span className="font-medium text-foreground">Save it for each host where it works</span> — kept
                        encrypted in the org Keystore, so reinstalls there do not ask again.
                      </span>
                    </label>
                  )}
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
          {/* Counted from the live statuses, not the server's final tally:
              a host fixed with a sudo password after the run must move out
              of "needs attention" the moment its retry succeeds. */}
          {!running && (summary || tally.stopped > 0) && (
            <div
              className={cn(
                'rounded-md border px-3 py-2 text-sm',
                tally.failed > 0 || tally.needsSudo > 0 || tally.stopped > 0
                  ? 'border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-200'
                  : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-800 dark:text-emerald-200'
              )}
            >
              {[
                `${tally.ok} succeeded`,
                tally.needsSudo > 0 && `${tally.needsSudo} need a sudo password`,
                tally.failed > 0 && `${tally.failed} failed`,
                tally.stopped > 0 && `${tally.stopped} not run`,
              ]
                .filter(Boolean)
                .join(', ')}
              .
              {tally.needsSudo > 0 &&
                ' Open a host marked “Needs attention” to enter its password and retry just that one.'}
              {tally.needsSudo === 0 && tally.failed > 0 && ' Open a failed host below to see why.'}
            </div>
          )}
          <div className="max-h-[22rem] space-y-1 overflow-y-auto rounded-lg border border-border p-2">
            {selectedTargets.map((t) => {
              const st = statuses[t.id] || { status: 'queued' };
              const lines = logs[t.id] || [];
              const isOpen = openLog === t.id;
              // Not a failure you debug — a password you type. It gets its
              // own treatment so it does not hide among real errors.
              const needsSudo = st.status === 'failed' && isSudoCode(st.code);
              const wrongSudo = needsSudo && st.code === SUDO_PASSWORD_INCORRECT;
              const isRetrying = !!retrying[t.id];
              return (
                <div
                  key={t.id}
                  className={cn(
                    'rounded border',
                    needsSudo ? 'border-amber-500/40 bg-amber-500/5' : 'border-transparent'
                  )}
                >
                  <button
                    type="button"
                    onClick={() => setOpenLog(isOpen ? null : t.id)}
                    aria-expanded={isOpen}
                    className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-accent/50"
                  >
                    {needsSudo ? (
                      <KeyRound className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
                    ) : (
                      <StatusIcon status={st.status} />
                    )}
                    <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                      {t.displayName || t.hostname}
                    </span>
                    {st.status === 'ok' && st.sudoSaved && (
                      <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-emerald-600 dark:text-emerald-400" title="The sudo password was saved to the Keystore for this host">
                        <KeyRound className="h-3 w-3" aria-hidden="true" /> sudo saved
                      </span>
                    )}
                    {needsSudo ? (
                      <span className="shrink-0 rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-300">
                        Needs attention
                      </span>
                    ) : (
                      st.error && (
                        <span
                          className={cn(
                            'max-w-[14rem] truncate text-xs',
                            st.status === 'stopped' ? 'text-muted-foreground' : 'text-destructive'
                          )}
                          title={st.error}
                        >
                          {st.error}
                        </span>
                      )
                    )}
                    {lines.length > 0 && (
                      <span className="shrink-0 text-[11px] text-muted-foreground">
                        {isOpen ? 'hide' : `${lines.length} lines`}
                      </span>
                    )}
                  </button>

                  {isOpen && needsSudo && (
                    <div className="mx-2 mb-2 space-y-2 rounded-md border border-amber-500/30 bg-background/60 p-3">
                      <p className="text-xs leading-relaxed text-foreground">
                        {wrongSudo ? (
                          <>
                            <span className="font-mono">sudo</span> refused the password it was given for{' '}
                            <span className="font-medium">{t.sshUser || 'this user'}</span>. Enter the right one to retry
                            just this host.
                          </>
                        ) : (
                          <>
                            <span className="font-medium">{t.sshUser || 'This user'}</span> needs a password for{' '}
                            <span className="font-mono">sudo</span> on this host. Enter it to retry just this host.
                          </>
                        )}
                      </p>
                      <form
                        className="flex flex-wrap items-center gap-2"
                        onSubmit={(e) => {
                          e.preventDefault();
                          retryWithSudo(t);
                        }}
                      >
                        <PasswordInput
                          value={sudoFixes[t.id] || ''}
                          onChange={(e) => setSudoFixes((p) => ({ ...p, [t.id]: e.target.value }))}
                          placeholder={`sudo password for ${t.sshUser || 'this user'}`}
                          autoComplete="new-password"
                          disabled={isRetrying}
                          className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                        />
                        <Button type="submit" size="sm" className="h-8" disabled={!sudoFixes[t.id] || isRetrying}>
                          {isRetrying ? (
                            <>
                              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> Retrying…
                            </>
                          ) : (
                            'Retry this host'
                          )}
                        </Button>
                      </form>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        {canSaveSudo ? (
                          <label className="flex cursor-pointer items-center gap-2 text-[11px] text-muted-foreground">
                            <Checkbox checked={rememberSudo} onChange={(e) => setRememberSudo(e.target.checked)} />
                            Save it for next time (org Keystore, only if it works)
                          </label>
                        ) : (
                          <span className="text-[11px] text-muted-foreground">Used once for this install; not stored.</span>
                        )}
                        {tally.needsSudo > 1 && sudoFixes[t.id] && !isRetrying && (
                          <button
                            type="button"
                            onClick={() => retryAllWaiting(sudoFixes[t.id])}
                            className="text-[11px] font-medium text-[hsl(var(--brand))] hover:underline"
                          >
                            Use it for all {tally.needsSudo} waiting hosts
                          </button>
                        )}
                      </div>
                    </div>
                  )}

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
