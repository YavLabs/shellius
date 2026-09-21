import { useState, useRef, useEffect } from 'react';
import { X, Terminal, Upload, Key, Lock, Building2, CheckCircle2, AlertCircle, Loader2 } from 'lucide-react';
import { provisionServer } from '@/services/serverService';
import { listCredentials } from '@/services/keystoreService';
import { useAuth } from '@/context/AuthContext';
import PasswordInput from '@/components/ui/PasswordInput';
import SearchableSelect from '@/components/ui/SearchableSelect';
import { SwitchField } from '@/components/ui/switch';
import useIsMobile from '@/hooks/useIsMobile';
import BottomSheet from '@/components/mobile/BottomSheet';

function ProvisionModal({ server, onClose, installMode = 'full' }) {
  const isMobile = useIsMobile();
  const { can } = useAuth();
  const [step, setStep] = useState('form'); // 'form' | 'running' | 'done' | 'error'
  const [privateKey, setPrivateKey] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [password, setPassword] = useState('');
  const [sshUser, setSshUser] = useState(server?.sshUser || '');
  const [sudoPassword, setSudoPassword] = useState('');
  const [needsSudo, setNeedsSudo] = useState(false);
  const [logs, setLogs] = useState([]);
  const [errorMsg, setErrorMsg] = useState('');
  const fileRef = useRef(null);
  const logsEndRef = useRef(null);

  // Saved identity (Keystore) — lets provisioning reuse an org or personal
  // credential instead of pasting a key/password every time.
  const [identities, setIdentities] = useState([]); // org identities
  const [personalIdentities, setPersonalIdentities] = useState([]); // caller's own — "Mine"
  // A credential-mode server already carries the identity that reaches it —
  // that identity is exactly what you would pick here, so preselect it. This
  // is the whole point of "I added an identity for the first connect, now
  // bootstrap the host with it".
  const boundCredentialId = server?.credentialId || server?.credential?.id || '';
  const [credentialId, setCredentialId] = useState(boundCredentialId);
  const hasIdentities = identities.length > 0 || personalIdentities.length > 0;
  // 'certificate' | 'identity' | 'manual'. Falls back to 'manual' below when
  // there is nothing to pick.
  const [authMode, setAuthMode] = useState(
    server?.provisionStatus === 'provisioned' || server?.agentId ? 'certificate' : 'identity'
  );

  useEffect(() => {
    if (can('keystore.view')) {
      listCredentials({ scope: 'org' })
        .then(setIdentities)
        .catch(() => setIdentities([]));
    }
    if (can('vault.use')) {
      listCredentials({ scope: 'personal' })
        .then(setPersonalIdentities)
        .catch(() => setPersonalIdentities([]));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The server's own identity is offered first and never depends on the two
  // list calls above: those need keystore.view / vault.use, but this one is
  // already bound to a server the caller can see, and the backend re-checks
  // it anyway (resolveCredentialForActor) before anything is used.
  const boundOption =
    boundCredentialId && !identities.some((c) => c.id === boundCredentialId) &&
    !personalIdentities.some((c) => c.id === boundCredentialId)
      ? [
          {
            value: boundCredentialId,
            label: server?.credential?.name || 'This server’s identity',
            sublabel: server?.credential?.username,
            scope: 'org',
          },
        ]
      : [];
  const combinedIdentityOptions = [
    ...boundOption,
    ...personalIdentities.map((c) => ({ value: c.id, label: c.name, sublabel: c.username, scope: 'personal' })),
    ...identities.map((c) => ({ value: c.id, label: c.name, sublabel: c.username, scope: 'org' })),
  ];
  const selectedIdentity =
    [...personalIdentities, ...identities].find((c) => c.id === credentialId) ||
    (credentialId && credentialId === boundCredentialId ? server?.credential : null);
  // A bootstrapped host already trusts the org CA, so Shellius can sign a
  // five-minute certificate and needs no secret at all. This is the easiest
  // and safest path when it is available, so it leads.
  const canUseCertificate = server?.provisionStatus === 'provisioned' || !!server?.agentId;
  const showModeSwitch =
    canUseCertificate ||
    ((can('keystore.view') || can('vault.use') || !!boundCredentialId) &&
      (hasIdentities || !!boundCredentialId));
  // Fall back to manual entry when there's nothing to pick, regardless of authMode's value.
  const mode = showModeSwitch ? authMode : 'manual';

  const handleFileUpload = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => setPrivateKey(ev.target.result);
    reader.readAsText(file);
  };

  // Manual mode keeps its long-standing rule: a key or a password is enough,
  // and an empty user means the "root" shown in the placeholder.
  const canSubmit =
    mode === 'certificate'
      ? true
      : mode === 'identity'
        ? !!credentialId
        : !!(privateKey.trim() || password);

  const handleStart = async () => {
    if (!canSubmit) return;
    setStep('running');
    setLogs([]);

    try {
      await provisionServer(server.id, {
        privateKey: mode === 'manual' ? privateKey.trim() || undefined : undefined,
        passphrase: mode === 'manual' ? passphrase || undefined : undefined,
        password: mode === 'manual' ? password || undefined : undefined,
        sshUser:
          mode === 'manual'
            ? sshUser.trim() || server?.sshUser || 'root'
            : // An empty override means "use the identity's own username".
              sshUser.trim() || undefined,
        sudoPassword: needsSudo ? sudoPassword : '',
        credentialId: mode === 'identity' ? credentialId : undefined,
        // Server-side this mints a 5-minute, this-host-only certificate and
        // connects with it — no secret is sent, stored or needed.
        useCertificate: mode === 'certificate' || undefined,
        // What to install: full (SSH + posture), ssh (SSH only), posture (collector only).
        mode: installMode,
        onLog: (msg) => {
          setLogs((prev) => [...prev, msg]);
          setTimeout(() => logsEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
        },
      });
      setStep('done');
    } catch (err) {
      setErrorMsg(err.message || 'Provisioning failed');
      setStep('error');
    }
  };

  const body = (
    <>
      {step === 'form' && (
        <div className="space-y-5 p-4 md:p-6">
          <div className="rounded-lg border border-border bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
            Shellius will SSH into{' '}
            <span className="font-mono text-foreground">{server?.ipAddress}</span> and install the
            agent automatically.{' '}
            {mode === 'certificate'
              ? 'This host is bootstrapped, so it already trusts your certificate authority \u2014 Shellius signs a 5-minute certificate for it. Nothing to enter, and no secret is stored.'
              : mode === 'identity'
                ? 'The identity\u2019s secret stays in the Keystore and is never sent to your browser.'
                : 'What you enter here is used once in memory and never stored.'}
          </div>

          {showModeSwitch && (
            <div className="flex gap-1 rounded-md border border-input bg-muted/30 p-1">
              {canUseCertificate && (
                <button
                  type="button"
                  onClick={() => setAuthMode('certificate')}
                  className={`flex-1 rounded px-3 py-1.5 text-sm font-medium transition-colors ${
                    mode === 'certificate'
                      ? 'bg-background text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  Certificate
                </button>
              )}
              <button
                type="button"
                onClick={() => setAuthMode('identity')}
                className={`flex-1 rounded px-3 py-1.5 text-sm font-medium transition-colors ${
                  mode === 'identity'
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                Saved identity
              </button>
              <button
                type="button"
                onClick={() => setAuthMode('manual')}
                className={`flex-1 rounded px-3 py-1.5 text-sm font-medium transition-colors ${
                  mode === 'manual'
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                Enter credentials
              </button>
            </div>
          )}

          {mode === 'identity' && (
            <div className="space-y-2">
              <label className="block text-sm font-medium text-foreground">
                <Key className="mr-1.5 inline h-3.5 w-3.5" />
                Saved identity
              </label>
              <SearchableSelect
                value={credentialId}
                onChange={setCredentialId}
                options={combinedIdentityOptions}
                placeholder="Select a saved identity..."
                clearable={false}
                renderOption={(o) => (
                  <span className="flex items-center gap-2">
                    {o.scope === 'personal' ? (
                      <Lock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    ) : (
                      <Building2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-foreground">{o.label}</span>
                      <span className="block truncate font-mono text-[11px] text-muted-foreground">
                        {o.scope === 'personal' ? 'Mine · ' : ''}
                        {o.sublabel}
                      </span>
                    </span>
                  </span>
                )}
              />
              {credentialId && credentialId === boundCredentialId && (
                <p className="text-xs text-muted-foreground">
                  This is the identity this server already connects with — it is preselected so you
                  can bootstrap straight away.
                </p>
              )}
            </div>
          )}

          {mode === 'manual' && (
            <div className="space-y-2">
              <label className="block text-sm font-medium text-foreground">
                <Key className="mr-1.5 inline h-3.5 w-3.5" />
                SSH Private Key
                <span className="ml-1 font-normal text-muted-foreground">
                  (key and/or password required)
                </span>
              </label>
              <textarea
                rows={8}
                className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                value={privateKey}
                onChange={(e) => setPrivateKey(e.target.value)}
                placeholder={'-----BEGIN OPENSSH PRIVATE KEY-----\n...\n-----END OPENSSH PRIVATE KEY-----'}
                spellCheck={false}
              />
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  className="inline-flex items-center gap-1.5 rounded-md border border-input bg-background px-3 py-1.5 text-xs font-medium text-foreground hover:bg-accent"
                >
                  <Upload className="h-3.5 w-3.5" />
                  Upload key file
                </button>
                <input
                  ref={fileRef}
                  type="file"
                  className="hidden"
                  onChange={handleFileUpload}
                  accept=".pem,.key,.pub,*"
                />
                <span className="text-xs text-muted-foreground">or paste above</span>
              </div>
              <PasswordInput
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                placeholder="Key passphrase (if the key is encrypted)"
                autoComplete="new-password"
              />
            </div>
          )}

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <label className="block text-sm font-medium text-foreground">
                SSH User
                {mode === 'identity' && (
                  <span className="ml-1 font-normal text-muted-foreground">(optional override)</span>
                )}
              </label>
              <input
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                value={sshUser}
                onChange={(e) => setSshUser(e.target.value)}
                placeholder={
                  mode === 'identity'
                    ? selectedIdentity?.username || 'root'
                    : mode === 'certificate'
                      ? server?.sshUser || 'root'
                      : 'root'
                }
              />
            </div>
            {mode === 'manual' && (
              <div className="space-y-2">
                <label className="block text-sm font-medium text-foreground">
                  <Lock className="mr-1.5 inline h-3.5 w-3.5" />
                  SSH Password
                </label>
                <PasswordInput
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="login password (if no key)"
                  autoComplete="new-password"
                />
              </div>
            )}
          </div>

          {/* Certificate auth carries no password, so there is nothing for
              `sudo -S` to read. Offering the switch here would promise
              something the mode cannot deliver; say the requirement plainly
              instead. */}
          {mode === 'certificate' ? (
            <p className="rounded-lg border border-border bg-muted/30 px-4 py-3 text-xs leading-relaxed text-muted-foreground">
              Certificate installs need <span className="font-medium text-foreground">passwordless sudo</span>{' '}
              for <span className="font-mono text-foreground">{sshUser.trim() || server?.sshUser || 'root'}</span>,
              because there is no password to give <span className="font-mono">sudo</span>. If this host prompts
              for one, use a saved identity or enter credentials instead.
            </p>
          ) : (
          <div className="space-y-3">
            <SwitchField
              label={
                <span className="inline-flex items-center gap-1.5">
                  <Lock className="h-3.5 w-3.5" /> Sudo requires a password
                </span>
              }
              description={
                mode === 'identity'
                  ? "The identity's saved password is used when left empty."
                  : undefined
              }
              checked={needsSudo}
              onCheckedChange={setNeedsSudo}
            />
            {needsSudo && (
              <PasswordInput
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                value={sudoPassword}
                onChange={(e) => setSudoPassword(e.target.value)}
                placeholder="sudo password"
                autoComplete="new-password"
              />
            )}
          </div>
          )}
        </div>
      )}

      {(step === 'running' || step === 'done' || step === 'error') && (
        <div className="flex h-full flex-col">
          <div className="flex-1 overflow-y-auto bg-ink p-4 font-mono text-xs text-ink-fg/80 max-md:min-h-[50dvh]">
            {logs.map((line, i) => (
              <div
                key={i}
                className={`leading-5 ${
                  line.startsWith('[shellius]')
                    ? 'text-emerald-400'
                    : line.startsWith('[stderr]')
                    ? 'text-red-400'
                    : 'text-ink-fg/80'
                }`}
              >
                {line}
              </div>
            ))}
            {step === 'running' && (
              <div className="mt-1 flex items-center gap-2 text-ink-muted">
                <Loader2 className="h-3 w-3 animate-spin" />
                <span>Running bootstrap...</span>
              </div>
            )}
            <div ref={logsEndRef} />
          </div>
          {(step === 'done' || step === 'error') && (
            <div
              className={`flex items-center gap-3 border-t border-border px-4 py-3 ${
                step === 'done' ? 'bg-emerald-500/10' : 'bg-destructive/10'
              }`}
            >
              {step === 'done' ? (
                <>
                  <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                  <span className="text-sm font-medium text-emerald-700 dark:text-emerald-400">
                    Provisioning completed successfully
                  </span>
                </>
              ) : (
                <>
                  <AlertCircle className="h-4 w-4 text-destructive" />
                  <span className="text-sm font-medium text-destructive">{errorMsg}</span>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </>
  );

  const footerActions = (
    <>
      {step === 'form' && (
        <>
          <button
            onClick={onClose}
            className="h-9 rounded-md border border-input bg-background px-4 text-sm font-medium text-foreground hover:bg-accent"
          >
            Cancel
          </button>
          <button
            onClick={handleStart}
            disabled={!canSubmit}
            className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            <Terminal className="h-4 w-4" />
            Start provisioning
          </button>
        </>
      )}
      {(step === 'done' || step === 'error') && (
        <button
          onClick={onClose}
          className="h-9 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          Close
        </button>
      )}
      {step === 'running' && (
        <span className="text-sm text-muted-foreground">Provisioning in progress...</span>
      )}
    </>
  );

  // Phones: a bottom sheet (docs/plans/1.5.1-mobile.md §3).
  if (isMobile) {
    return (
      <BottomSheet
        open
        onClose={onClose}
        title={
          <span className="block">
            Auto-Provision Server
            <span className="block truncate text-xs font-normal text-muted-foreground">{server?.hostname}</span>
          </span>
        }
        icon={<Terminal className="h-5 w-5 text-primary" />}
        bodyClassName="px-0 pt-0"
        footer={<div className="flex items-center justify-end gap-2">{footerActions}</div>}
      >
        {body}
      </BottomSheet>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="relative flex h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-border bg-background shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-6 py-4">
          <div className="flex items-center gap-3">
            <Terminal className="h-5 w-5 text-primary" />
            <div>
              <h2 className="text-base font-semibold text-foreground">
                {installMode === 'posture'
                  ? 'Install posture collector'
                  : installMode === 'ssh'
                    ? 'Bootstrap host (SSH only)'
                    : 'Bootstrap host'}
              </h2>
              <p className="text-xs text-muted-foreground">{server?.hostname}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto">
          {body}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 border-t border-border px-6 py-4">
          {footerActions}
        </div>
      </div>
    </div>
  );
}

export default ProvisionModal;
