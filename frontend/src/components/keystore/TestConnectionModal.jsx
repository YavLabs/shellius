import { useEffect, useState } from 'react';
import { CheckCircle2, XCircle, Loader2 } from 'lucide-react';
import Modal from '@/components/shared/Modal';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import SearchableSelect from '@/components/ui/SearchableSelect';
import { testCredential } from '@/services/keystoreService';
import { listServers } from '@/services/serverService';

/**
 * TestConnectionModal — tests a Keystore identity against either a saved
 * server or an ad-hoc host:port.
 */
function TestConnectionModal({ open, onClose, credential, scope = 'org' }) {
  const isPersonal = scope === 'personal';
  const [mode, setMode] = useState(isPersonal ? 'manual' : 'server'); // 'server' | 'manual'
  const [serverId, setServerId] = useState('');
  const [servers, setServers] = useState([]);
  const [host, setHost] = useState('');
  const [port, setPort] = useState('22');
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setMode(isPersonal ? 'manual' : 'server');
    setServerId('');
    setHost('');
    setPort('22');
    setResult(null);
    setError('');
    if (isPersonal) return;
    listServers({ page: 1, pageSize: 500 })
      .then((data) => setServers(data.items || []))
      .catch(() => setServers([]));
  }, [open, isPersonal]);

  const handleTest = async () => {
    setError('');
    setResult(null);
    setTesting(true);
    try {
      const payload = mode === 'server' ? { serverId } : { host: host.trim(), port: port ? Number(port) : undefined };
      const r = await testCredential(credential.id, payload);
      setResult(r);
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message || 'Test failed');
    } finally {
      setTesting(false);
    }
  };

  const canTest = mode === 'server' ? !!serverId : !!host.trim();

  return (
    <Modal open={open} onClose={onClose} title={`Test connection — ${credential?.name || ''}`} size="sm">
      <div className="space-y-4">
        {!isPersonal && (
          <div className="flex gap-4 text-sm">
            <label className="flex cursor-pointer items-center gap-2">
              <input type="radio" checked={mode === 'server'} onChange={() => setMode('server')} />
              Saved server
            </label>
            <label className="flex cursor-pointer items-center gap-2">
              <input type="radio" checked={mode === 'manual'} onChange={() => setMode('manual')} />
              Host / port
            </label>
          </div>
        )}

        {mode === 'server' ? (
          <SearchableSelect
            value={serverId}
            onChange={setServerId}
            options={servers.map((s) => ({ value: s.id, label: s.displayName || s.hostname, sublabel: s.hostname }))}
            placeholder="Select a server..."
            clearable={false}
          />
        ) : (
          <div className="grid grid-cols-3 gap-2">
            <div className="col-span-2">
              <label className="mb-1 block text-xs font-medium text-muted-foreground">Host</label>
              <Input value={host} onChange={(e) => setHost(e.target.value)} placeholder="10.0.0.1" />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">Port</label>
              <Input value={port} onChange={(e) => setPort(e.target.value)} placeholder="22" />
            </div>
          </div>
        )}

        {error && (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        {result && (
          <div
            className={`rounded-md border px-3 py-2.5 text-sm ${
              result.ok
                ? 'border-emerald-500/40 bg-emerald-500/10'
                : 'border-destructive/50 bg-destructive/10'
            }`}
          >
            <div className="flex items-center gap-2">
              {result.ok ? (
                <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
              ) : (
                <XCircle className="h-4 w-4 text-destructive" />
              )}
              <span className={result.ok ? 'font-medium text-emerald-700 dark:text-emerald-300' : 'font-medium text-destructive'}>
                {result.ok ? 'Connected successfully' : 'Connection failed'}
              </span>
            </div>
            {result.message && <p className="mt-1 text-xs text-muted-foreground">{result.message}</p>}
            {result.hostKeyFingerprint && (
              <p className="mt-1 font-mono text-[11px] text-muted-foreground">
                Host key ({result.hostKeyAlgorithm || 'unknown'}): {result.hostKeyFingerprint}
              </p>
            )}
            {typeof result.durationMs === 'number' && (
              <p className="mt-1 text-[11px] text-muted-foreground">{result.durationMs}ms</p>
            )}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          <Button onClick={handleTest} disabled={!canTest || testing}>
            {testing ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Testing...
              </>
            ) : (
              'Test connection'
            )}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export default TestConnectionModal;
