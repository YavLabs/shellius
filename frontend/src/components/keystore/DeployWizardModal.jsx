import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';
import Modal from '@/components/shared/Modal';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import SearchableSelect from '@/components/ui/SearchableSelect';
import EnvironmentBadge from '@/components/shared/EnvironmentBadge';
import { Badge } from '@/components/ui/badge';
import { statusTone } from '@/lib/badgeTones';
import { listKeys, listCredentials, createDeployments, listDeployments } from '@/services/keystoreService';
import { listServers } from '@/services/serverService';

const ACTIONS = [
  { value: 'deploy', label: 'Deploy' },
  { value: 'remove', label: 'Remove' },
  { value: 'rotate', label: 'Rotate' },
];

const ENVIRONMENTS = ['demo', 'dev', 'staging', 'prod'];

/**
 * DeployWizardModal — reusable deploy/remove/rotate wizard. Launched from the
 * Keystore Deployments tab, ServerDetail's More menu, and Servers bulk
 * selection.
 *
 * Props:
 *   open, onClose
 *   preselectedKeyId?     — pin the key (still changeable unless lockKey)
 *   preselectedServerIds? — pre-check these servers
 *   lockKey?               — hide the key picker (server-initiated flow)
 *   defaultAction?          — 'deploy' | 'remove' | 'rotate'
 *   onDone?(batchId)       — called once the batch is created
 */
function DeployWizardModal({
  open,
  onClose,
  preselectedKeyId,
  preselectedServerIds,
  lockKey = false,
  defaultAction = 'deploy',
  onDone,
}) {
  const [step, setStep] = useState(1);

  // Step 1 — key + action
  const [keys, setKeys] = useState([]);
  const [sshKeyId, setSshKeyId] = useState('');
  const [action, setAction] = useState(defaultAction);
  const [oldSshKeyId, setOldSshKeyId] = useState('');
  const [updateCredentials, setUpdateCredentials] = useState(true);

  // Step 2 — servers
  const [servers, setServers] = useState([]);
  const [serverSearch, setServerSearch] = useState('');
  const [envFilter, setEnvFilter] = useState('');
  const [selectedServerIds, setSelectedServerIds] = useState([]);

  // Step 3 — auth
  const [authMode, setAuthMode] = useState('server');
  const [credentials, setCredentials] = useState([]);
  const [credentialId, setCredentialId] = useState('');
  const [targetUser, setTargetUser] = useState('');
  const [useSudo, setUseSudo] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  // Progress (step 4)
  const [batchId, setBatchId] = useState(null);
  const [deployments, setDeployments] = useState([]);

  useEffect(() => {
    if (!open) return;
    setStep(1);
    setSshKeyId(preselectedKeyId || '');
    setAction(defaultAction);
    setOldSshKeyId('');
    setUpdateCredentials(true);
    setServerSearch('');
    setEnvFilter('');
    setSelectedServerIds(preselectedServerIds || []);
    setAuthMode('server');
    setCredentialId('');
    setTargetUser('');
    setUseSudo(false);
    setError('');
    setBatchId(null);
    setDeployments([]);

    listKeys().then(setKeys).catch(() => setKeys([]));
    listCredentials().then(setCredentials).catch(() => setCredentials([]));
    listServers({ page: 1, pageSize: 500 })
      .then((data) => setServers((data.items || []).filter((s) => s.protocol !== 'rdp')))
      .catch(() => setServers([]));
  }, [open, preselectedKeyId, preselectedServerIds, defaultAction]);

  // Poll batch progress while any row is pending/running
  useEffect(() => {
    if (step !== 4 || !batchId) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const data = await listDeployments({ batchId, pageSize: 500 });
        if (!cancelled) setDeployments(data.deployments || []);
      } catch {
        /* ignore transient errors */
      }
    };
    poll();
    const hasPending = deployments.some((d) => d.status === 'pending' || d.status === 'running');
    const id = hasPending || deployments.length === 0 ? setInterval(poll, 3000) : null;
    return () => {
      cancelled = true;
      if (id) clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, batchId, deployments.length, deployments.map((d) => d.status).join(',')]);

  const filteredServers = useMemo(() => {
    const q = serverSearch.trim().toLowerCase();
    return servers.filter((s) => {
      if (envFilter && s.environment !== envFilter) return false;
      if (!q) return true;
      return `${s.displayName || ''} ${s.hostname} ${s.ipAddress || ''}`.toLowerCase().includes(q);
    });
  }, [servers, serverSearch, envFilter]);

  const selectedServers = servers.filter((s) => selectedServerIds.includes(s.id));
  const hasProd = selectedServers.some((s) => s.environment === 'prod');

  const toggleServer = (id) => {
    setSelectedServerIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const toggleAllVisible = () => {
    const visibleIds = filteredServers.map((s) => s.id);
    const allSelected = visibleIds.every((id) => selectedServerIds.includes(id));
    if (allSelected) {
      setSelectedServerIds((prev) => prev.filter((id) => !visibleIds.includes(id)));
    } else {
      setSelectedServerIds((prev) => [...new Set([...prev, ...visibleIds])]);
    }
  };

  const canNextFrom1 = !!sshKeyId && (action !== 'rotate' || !!oldSshKeyId);
  const canNextFrom2 = selectedServerIds.length > 0;
  const canNextFrom3 = authMode === 'server' || !!credentialId;

  const handleBack = () => setStep((s) => Math.max(1, s - 1));

  const handleSubmit = async () => {
    setSubmitting(true);
    setError('');
    try {
      const payload = {
        sshKeyId,
        serverIds: selectedServerIds,
        action,
        targetUser: targetUser.trim() || undefined,
        auth: authMode === 'server' ? { mode: 'server' } : { mode: 'credential', credentialId },
        useSudo,
      };
      if (action === 'rotate') {
        payload.rotate = { oldSshKeyId, updateCredentials };
      }
      const resp = await createDeployments(payload);
      setBatchId(resp.batchId);
      setDeployments(resp.deployments || []);
      setStep(4);
      onDone?.(resp.batchId);
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message || 'Failed to start deployment');
    } finally {
      setSubmitting(false);
    }
  };

  const counts = useMemo(() => {
    const c = { pending: 0, running: 0, success: 0, failed: 0, total: deployments.length };
    for (const d of deployments) c[d.status] = (c[d.status] || 0) + 1;
    return c;
  }, [deployments]);

  const title =
    step === 4
      ? 'Deployment progress'
      : `${action === 'deploy' ? 'Deploy' : action === 'remove' ? 'Remove' : 'Rotate'} SSH key`;

  return (
    <Modal open={open} onClose={onClose} title={title} size="lg">
      <div className="space-y-4">
        {step !== 4 && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            {['Key & action', 'Servers', 'Authentication'].map((label, idx) => (
              <span key={label} className={`flex items-center gap-1 ${step === idx + 1 ? 'font-medium text-foreground' : ''}`}>
                {idx > 0 && <ChevronRight className="h-3 w-3" />}
                {idx + 1}. {label}
              </span>
            ))}
          </div>
        )}

        {error && (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        {step === 1 && (
          <div className="space-y-4">
            <div>
              <label className="mb-1.5 block text-sm font-medium text-foreground">Action</label>
              <div className="flex gap-4">
                {ACTIONS.map((a) => (
                  <label key={a.value} className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
                    <input type="radio" checked={action === a.value} onChange={() => setAction(a.value)} />
                    {a.label}
                  </label>
                ))}
              </div>
            </div>
            {!lockKey && (
              <div>
                <label className="mb-1.5 block text-sm font-medium text-foreground">
                  {action === 'rotate' ? 'New key' : 'Key'}
                </label>
                <SearchableSelect
                  value={sshKeyId}
                  onChange={setSshKeyId}
                  options={keys.map((k) => ({ value: k.id, label: k.name, sublabel: k.fingerprint }))}
                  placeholder="Select a key..."
                  clearable={false}
                />
              </div>
            )}
            {action === 'rotate' && (
              <>
                <div>
                  <label className="mb-1.5 block text-sm font-medium text-foreground">Old key (being replaced)</label>
                  <SearchableSelect
                    value={oldSshKeyId}
                    onChange={setOldSshKeyId}
                    options={keys
                      .filter((k) => k.id !== sshKeyId)
                      .map((k) => ({ value: k.id, label: k.name, sublabel: k.fingerprint }))}
                    placeholder="Select the key to retire..."
                    clearable={false}
                  />
                </div>
                <label className="flex items-center gap-2 text-sm text-foreground">
                  <input
                    type="checkbox"
                    checked={updateCredentials}
                    onChange={(e) => setUpdateCredentials(e.target.checked)}
                    className="rounded border-border accent-primary"
                  />
                  Update identities that use the old key to point at the new key
                </label>
              </>
            )}
          </div>
        )}

        {step === 2 && (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Input
                value={serverSearch}
                onChange={(e) => setServerSearch(e.target.value)}
                placeholder="Search servers..."
                className="flex-1"
              />
              <SearchableSelect
                className="w-[160px]"
                value={envFilter}
                onChange={setEnvFilter}
                options={[{ value: '', label: 'All environments' }, ...ENVIRONMENTS.map((e) => ({ value: e, label: e }))]}
                searchable={false}
                clearable={false}
              />
            </div>
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <button type="button" onClick={toggleAllVisible} className="text-primary hover:underline">
                Select / deselect all visible
              </button>
              <span>{selectedServerIds.length} selected</span>
            </div>
            <div className="max-h-64 overflow-y-auto rounded-md border border-border">
              {filteredServers.length === 0 ? (
                <p className="px-3 py-6 text-center text-sm text-muted-foreground">No servers match.</p>
              ) : (
                <ul className="divide-y divide-border">
                  {filteredServers.map((s) => (
                    <li key={s.id}>
                      <label className="flex cursor-pointer items-center justify-between gap-2 px-3 py-2 text-sm hover:bg-accent/40">
                        <span className="flex min-w-0 items-center gap-2">
                          <input
                            type="checkbox"
                            checked={selectedServerIds.includes(s.id)}
                            onChange={() => toggleServer(s.id)}
                            className="rounded border-border accent-primary"
                          />
                          <span className="truncate">{s.displayName || s.hostname}</span>
                          <Badge tone="neutral" className="shrink-0">
                            {s.authMode === 'credential' ? 'Identity' : 'Certificate'}
                          </Badge>
                        </span>
                        <EnvironmentBadge environment={s.environment} />
                      </label>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {hasProd && (
              <div className="flex items-start gap-2 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-400">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                One or more selected servers are production. Double-check before deploying.
              </div>
            )}
          </div>
        )}

        {step === 3 && (
          <div className="space-y-4">
            <div>
              <label className="mb-1.5 block text-sm font-medium text-foreground">Authenticate as</label>
              <div className="space-y-2">
                <label className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
                  <input type="radio" checked={authMode === 'server'} onChange={() => setAuthMode('server')} />
                  Use each server&apos;s own access (CA certificate, or its stored identity)
                </label>
                <label className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
                  <input type="radio" checked={authMode === 'credential'} onChange={() => setAuthMode('credential')} />
                  Use a specific identity
                </label>
              </div>
              {authMode === 'credential' && (
                <div className="mt-2">
                  <SearchableSelect
                    value={credentialId}
                    onChange={setCredentialId}
                    options={credentials.map((c) => ({ value: c.id, label: c.name, sublabel: c.username }))}
                    placeholder="Select an identity..."
                    clearable={false}
                  />
                </div>
              )}
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium text-foreground">
                Target user <span className="font-normal text-muted-foreground">(optional — default is the login user)</span>
              </label>
              <Input value={targetUser} onChange={(e) => setTargetUser(e.target.value)} placeholder="e.g. deploy" />
            </div>
            <label className="flex items-center gap-2 text-sm text-foreground">
              <input
                type="checkbox"
                checked={useSudo}
                onChange={(e) => setUseSudo(e.target.checked)}
                className="rounded border-border accent-primary"
              />
              Use sudo to write another user&apos;s authorized_keys
            </label>

            <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
              {action === 'deploy' && `Deploy the key to ${selectedServerIds.length} server(s).`}
              {action === 'remove' && `Remove the key from ${selectedServerIds.length} server(s).`}
              {action === 'rotate' &&
                `Rotate: deploy new key → verify login → remove old key on ${selectedServerIds.length} server(s).`}
            </div>
          </div>
        )}

        {step === 4 && (
          <div className="space-y-3">
            <div className="flex h-3 w-full overflow-hidden rounded-full bg-muted">
              {counts.total > 0 && (
                <>
                  <div className="bg-emerald-500" style={{ width: `${(counts.success / counts.total) * 100}%` }} />
                  <div className="bg-destructive" style={{ width: `${(counts.failed / counts.total) * 100}%` }} />
                  <div className="bg-blue-500" style={{ width: `${(counts.running / counts.total) * 100}%` }} />
                </>
              )}
            </div>
            <div className="flex gap-4 text-xs text-muted-foreground">
              <span>{counts.success || 0} success</span>
              <span>{counts.failed || 0} failed</span>
              <span>{counts.running || 0} running</span>
              <span>{counts.pending || 0} pending</span>
            </div>
            <div className="max-h-72 overflow-y-auto rounded-md border border-border">
              <ul className="divide-y divide-border">
                {deployments.map((d) => {
                  const meta = statusTone(d.status);
                  return (
                    <li key={d.id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
                      <span className="truncate">{d.server?.displayName || d.server?.hostname}</span>
                      <Badge tone={meta.tone} className="shrink-0">{meta.label}</Badge>
                    </li>
                  );
                })}
              </ul>
            </div>
          </div>
        )}

        <div className="flex justify-between gap-2 pt-1">
          <div>
            {step > 1 && step < 4 && (
              <Button type="button" variant="outline" onClick={handleBack}>
                <ChevronLeft className="mr-1 h-4 w-4" /> Back
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              {step === 4 ? 'Close' : 'Cancel'}
            </Button>
            {step === 1 && (
              <Button type="button" disabled={!canNextFrom1} onClick={() => setStep(2)}>
                Next <ChevronRight className="ml-1 h-4 w-4" />
              </Button>
            )}
            {step === 2 && (
              <Button type="button" disabled={!canNextFrom2} onClick={() => setStep(3)}>
                Next <ChevronRight className="ml-1 h-4 w-4" />
              </Button>
            )}
            {step === 3 && (
              <Button type="button" disabled={!canNextFrom3 || submitting} onClick={handleSubmit}>
                {submitting ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Starting...
                  </>
                ) : (
                  'Deploy'
                )}
              </Button>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}

export default DeployWizardModal;
