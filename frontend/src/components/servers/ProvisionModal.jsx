import { useState, useRef } from 'react';
import { X, Terminal, Upload, Key, Lock, CheckCircle2, AlertCircle, Loader2 } from 'lucide-react';
import { provisionServer } from '@/services/serverService';
import PasswordInput from '@/components/ui/PasswordInput';

function ProvisionModal({ server, onClose }) {
  const [step, setStep] = useState('form'); // 'form' | 'running' | 'done' | 'error'
  const [privateKey, setPrivateKey] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [password, setPassword] = useState('');
  const [sshUser, setSshUser] = useState(server?.sshUser || 'root');
  const [sudoPassword, setSudoPassword] = useState('');
  const [needsSudo, setNeedsSudo] = useState(false);
  const [logs, setLogs] = useState([]);
  const [errorMsg, setErrorMsg] = useState('');
  const fileRef = useRef(null);
  const logsEndRef = useRef(null);

  const handleFileUpload = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => setPrivateKey(ev.target.result);
    reader.readAsText(file);
  };

  const handleStart = async () => {
    if (!privateKey.trim() && !password) return;
    setStep('running');
    setLogs([]);

    try {
      await provisionServer(server.id, {
        privateKey: privateKey.trim() || undefined,
        passphrase: passphrase || undefined,
        password: password || undefined,
        sshUser,
        sudoPassword: needsSudo ? sudoPassword : '',
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="relative flex h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-border bg-background shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-6 py-4">
          <div className="flex items-center gap-3">
            <Terminal className="h-5 w-5 text-primary" />
            <div>
              <h2 className="text-base font-semibold text-foreground">Auto-Provision Server</h2>
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
          {step === 'form' && (
            <div className="space-y-5 p-6">
              <div className="rounded-lg border border-border bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
                Shellius will SSH into{' '}
                <span className="font-mono text-foreground">{server?.ipAddress}</span> using your
                private key and install the agent automatically. Your key is used once in memory and
                never stored.
              </div>

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

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <label className="block text-sm font-medium text-foreground">SSH User</label>
                  <input
                    className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                    value={sshUser}
                    onChange={(e) => setSshUser(e.target.value)}
                  />
                </div>
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
              </div>

              <div className="space-y-3">
                <label className="flex cursor-pointer items-center gap-2 text-sm font-medium text-foreground">
                  <input
                    type="checkbox"
                    checked={needsSudo}
                    onChange={(e) => setNeedsSudo(e.target.checked)}
                    className="rounded border-border"
                  />
                  <Lock className="h-3.5 w-3.5" />
                  Sudo requires a password
                </label>
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
            </div>
          )}

          {(step === 'running' || step === 'done' || step === 'error') && (
            <div className="flex h-full flex-col">
              <div className="flex-1 overflow-y-auto bg-zinc-950 p-4 font-mono text-xs text-zinc-300">
                {logs.map((line, i) => (
                  <div
                    key={i}
                    className={`leading-5 ${
                      line.startsWith('[shellius]')
                        ? 'text-emerald-400'
                        : line.startsWith('[stderr]')
                        ? 'text-red-400'
                        : 'text-zinc-300'
                    }`}
                  >
                    {line}
                  </div>
                ))}
                {step === 'running' && (
                  <div className="mt-1 flex items-center gap-2 text-zinc-500">
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
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 border-t border-border px-6 py-4">
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
                disabled={!privateKey.trim() && !password}
                className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                <Terminal className="h-4 w-4" />
                Start Provisioning
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
        </div>
      </div>
    </div>
  );
}

export default ProvisionModal;
