import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronDown, ChevronRight, Upload, Clock, Loader2, AlertTriangle } from 'lucide-react';
import Modal from '@/components/shared/Modal';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import PasswordInput from '@/components/ui/PasswordInput';
import SearchableSelect from '@/components/ui/SearchableSelect';
import SaveServerFields from './SaveServerFields';
import { createQuickConnectTicket, saveQuickConnectServer } from '@/services/quickConnectService';
import { listCredentials } from '@/services/keystoreService';
import { useAuth } from '@/context/AuthContext';
import { roleAtLeast } from '@/lib/permissions';
import { getRecentConnections, addRecentConnection } from '@/lib/quickConnectRecent';

const AUTH_TABS = [
  { value: 'password', label: 'Password' },
  { value: 'key', label: 'Private key' },
  { value: 'credential', label: 'Saved identity' },
];

const inputCls =
  'h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring';
const labelCls = 'mb-1.5 block text-sm font-medium text-foreground';

// Splits a pasted "user@host:port" string into its parts. Returns null
// pieces for anything not present so callers can merge with existing state.
function parseHostPaste(raw) {
  let rest = raw.trim();
  let user = null;
  let port = null;
  const atIdx = rest.lastIndexOf('@');
  if (atIdx > -1) {
    user = rest.slice(0, atIdx);
    rest = rest.slice(atIdx + 1);
  }
  const colonIdx = rest.lastIndexOf(':');
  if (colonIdx > -1 && /^\d+$/.test(rest.slice(colonIdx + 1))) {
    port = rest.slice(colonIdx + 1);
    rest = rest.slice(0, colonIdx);
  }
  return { host: rest || null, user, port };
}

function QuickConnectModal({ open, onClose }) {
  const navigate = useNavigate();
  const { user: currentUser } = useAuth();
  const canCreateIdentity = roleAtLeast(currentUser, 'admin');

  const [host, setHost] = useState('');
  const [port, setPort] = useState('22');
  const [username, setUsername] = useState('');
  const [authTab, setAuthTab] = useState('password');

  const [password, setPassword] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [keyPassphrase, setKeyPassphrase] = useState('');
  const [credentialId, setCredentialId] = useState('');
  const [identities, setIdentities] = useState([]);

  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [expectedHostKey, setExpectedHostKey] = useState('');

  const [saveOn, setSaveOn] = useState(false);
  const [saveValues, setSaveValues] = useState({ identityMode: 'existing', environment: 'dev' });

  const [recent, setRecent] = useState([]);
  const [connecting, setConnecting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null); // { message, serverId? }

  useEffect(() => {
    if (!open) return;
    setHost('');
    setPort('22');
    setUsername('');
    setAuthTab('password');
    setPassword('');
    setPrivateKey('');
    setKeyPassphrase('');
    setCredentialId('');
    setAdvancedOpen(false);
    setExpectedHostKey('');
    setSaveOn(false);
    setSaveValues({ identityMode: 'existing', environment: 'dev' });
    setError(null);
    setRecent(getRecentConnections());
    listCredentials()
      .then(setIdentities)
      .catch(() => setIdentities([]));
  }, [open]);

  const handleHostPaste = (e) => {
    const text = e.clipboardData?.getData('text');
    if (!text || (!text.includes('@') && !text.includes(':'))) return;
    const parsed = parseHostPaste(text);
    if (parsed.host && (parsed.user || parsed.port)) {
      e.preventDefault();
      setHost(parsed.host);
      if (parsed.user) setUsername(parsed.user);
      if (parsed.port) setPort(parsed.port);
    }
  };

  const applyRecent = (r) => {
    setHost(r.host);
    setPort(String(r.port || 22));
    setUsername(r.username || '');
    if (r.identityId) {
      setAuthTab('credential');
      setCredentialId(r.identityId);
    }
  };

  const buildAuth = () => {
    if (authTab === 'password') return { type: 'password', password };
    if (authTab === 'key') return { type: 'key', privateKey: privateKey.trim(), passphrase: keyPassphrase || undefined };
    return { type: 'credential', credentialId };
  };

  const canConnect = useMemo(() => {
    if (!host.trim()) return false;
    if (authTab === 'password') return !!username.trim() && !!password;
    if (authTab === 'key') return !!username.trim() && !!privateKey.trim();
    return !!credentialId; // username may be inferred from identity
  }, [host, authTab, username, password, privateKey, credentialId]);

  const handleFileUpload = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setPrivateKey(String(reader.result || ''));
    reader.readAsText(file);
  };

  const doConnect = async () => {
    setError(null);
    setConnecting(true);
    // Open a blank tab synchronously (before the await) so popup blockers
    // don't kick in once we're back from the network call.
    const win = window.open('', '_blank');
    try {
      const resp = await createQuickConnectTicket({
        host: host.trim(),
        port: Number(port) || 22,
        username: username.trim() || undefined,
        auth: buildAuth(),
        expectedHostKey: expectedHostKey.trim() || undefined,
      });
      addRecentConnection({
        host: host.trim(),
        port: Number(port) || 22,
        username: username.trim(),
        identityId: authTab === 'credential' ? credentialId : null,
      });
      const label = `${username.trim() || 'user'}@${host.trim()}`;
      const url = `/terminal?ticket=${encodeURIComponent(resp.ticket)}&label=${encodeURIComponent(label)}`;
      if (win) win.location = url;
      else window.open(url, '_blank');
      onClose();
    } catch (err) {
      if (win) win.close();
      const code = err.response?.data?.error?.code;
      if (code === 'PROD_HOST_REQUIRES_APPROVAL') {
        setError({
          message:
            err.response?.data?.error?.message ||
            'This host matches a production server and requires the access-request flow.',
          serverId:
            err.response?.data?.error?.serverId || err.response?.data?.error?.details?.serverId,
        });
      } else {
        setError({ message: err.response?.data?.error?.message || err.message || 'Failed to connect' });
      }
    } finally {
      setConnecting(false);
    }
  };

  const doSave = async (thenConnect) => {
    setError(null);
    setSaving(true);
    try {
      const payload = {
        host: host.trim(),
        port: Number(port) || 22,
        username: username.trim(),
        hostname: saveValues.hostname?.trim() || host.trim(),
        displayName: saveValues.displayName?.trim() || undefined,
        customerId: saveValues.customerId,
        environment: saveValues.environment || 'dev',
        description: saveValues.description?.trim() || undefined,
        hostKeyFingerprint: expectedHostKey.trim() || undefined,
      };
      if (saveValues.identityMode === 'existing') {
        payload.identity = { mode: 'existing', credentialId: saveValues.identityId };
      } else if (saveValues.identityMode === 'new' && canCreateIdentity) {
        payload.identity = { mode: 'new', name: saveValues.newIdentityName?.trim(), auth: buildAuth() };
      } else {
        payload.identity = { mode: 'none' };
      }
      await saveQuickConnectServer(payload);
      if (thenConnect) {
        await doConnect();
      } else {
        onClose();
      }
    } catch (err) {
      setError({ message: err.response?.data?.error?.message || err.message || 'Failed to save server' });
    } finally {
      setSaving(false);
    }
  };

  const busy = connecting || saving;

  return (
    <Modal open={open} onClose={onClose} title="Quick Connect" size="md">
      <div className="space-y-4">
        {error && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <p>{error.message}</p>
              {error.serverId && (
                <button
                  type="button"
                  onClick={() => {
                    onClose();
                    navigate(`/servers/${error.serverId}`);
                  }}
                  className="mt-1 text-xs font-medium underline"
                >
                  View server details
                </button>
              )}
            </div>
          </div>
        )}

        {recent.length > 0 && (
          <div>
            <p className="mb-1.5 flex items-center gap-1 text-xs font-medium text-muted-foreground">
              <Clock className="h-3 w-3" /> Recent
            </p>
            <div className="flex flex-wrap gap-1.5">
              {recent.map((r, i) => (
                <button
                  key={`${r.host}:${r.port}:${r.username}:${i}`}
                  type="button"
                  onClick={() => applyRecent(r)}
                  className="rounded-full border border-border bg-muted/40 px-2.5 py-1 font-mono text-xs text-foreground hover:bg-accent"
                >
                  {r.username ? `${r.username}@` : ''}
                  {r.host}
                  {r.port && r.port !== 22 ? `:${r.port}` : ''}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="grid grid-cols-3 gap-3">
          <div className="col-span-2">
            <label className={labelCls}>
              Host <span className="text-destructive">*</span>
            </label>
            <input
              className={`${inputCls} font-mono`}
              value={host}
              onChange={(e) => setHost(e.target.value)}
              onPaste={handleHostPaste}
              placeholder="user@host:port or host"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div>
            <label className={labelCls}>Port</label>
            <input
              className={inputCls}
              value={port}
              onChange={(e) => setPort(e.target.value)}
              placeholder="22"
              inputMode="numeric"
            />
          </div>
        </div>

        <div>
          <label className={labelCls}>
            Username{' '}
            {authTab === 'credential' && (
              <span className="font-normal text-muted-foreground">(optional — from identity)</span>
            )}
          </label>
          <input
            className={inputCls}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="root"
            autoComplete="off"
          />
        </div>

        <div>
          <div className="flex gap-4 border-b border-border">
            {AUTH_TABS.map((t) => (
              <button
                key={t.value}
                type="button"
                onClick={() => setAuthTab(t.value)}
                className={`px-1 pb-2 text-sm font-medium transition-colors ${
                  authTab === t.value
                    ? 'border-b-2 border-primary text-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          <div className="pt-3">
            {authTab === 'password' && (
              <PasswordInput
                className={inputCls}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Password"
                autoComplete="off"
              />
            )}
            {authTab === 'key' && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-medium text-muted-foreground">Private key</label>
                  <label className="flex cursor-pointer items-center gap-1 text-xs text-primary hover:underline">
                    <Upload className="h-3 w-3" />
                    Upload file
                    <input type="file" className="hidden" onChange={handleFileUpload} />
                  </label>
                </div>
                <textarea
                  rows={4}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                  value={privateKey}
                  onChange={(e) => setPrivateKey(e.target.value)}
                  placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                  spellCheck={false}
                />
                <PasswordInput
                  className={inputCls}
                  value={keyPassphrase}
                  onChange={(e) => setKeyPassphrase(e.target.value)}
                  placeholder="Passphrase (if encrypted)"
                  autoComplete="off"
                />
              </div>
            )}
            {authTab === 'credential' && (
              <SearchableSelect
                value={credentialId}
                onChange={(v) => {
                  setCredentialId(v);
                  const id = identities.find((c) => c.id === v);
                  if (id?.username && !username) setUsername(id.username);
                }}
                options={identities.map((c) => ({ value: c.id, label: c.name, sublabel: c.username }))}
                placeholder="Select a saved identity..."
                clearable={false}
              />
            )}
          </div>
        </div>

        <div>
          <button
            type="button"
            onClick={() => setAdvancedOpen((o) => !o)}
            className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            {advancedOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            Advanced
          </button>
          {advancedOpen && (
            <div className="mt-2">
              <label className={labelCls}>Expected host key fingerprint</label>
              <input
                className={`${inputCls} font-mono`}
                value={expectedHostKey}
                onChange={(e) => setExpectedHostKey(e.target.value)}
                placeholder="SHA256:..."
              />
            </div>
          )}
        </div>

        <label className="flex items-center gap-2 text-sm text-foreground">
          <input
            type="checkbox"
            checked={saveOn}
            onChange={(e) => setSaveOn(e.target.checked)}
            className="rounded border-border accent-primary"
          />
          Save as server
        </label>

        {saveOn && (
          <SaveServerFields
            values={saveValues}
            onChange={setSaveValues}
            identities={identities}
            canCreateIdentity={canCreateIdentity}
            identityModes={['existing', 'new', 'none']}
          />
        )}

        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          {saveOn ? (
            <>
              <Button type="button" variant="outline" disabled={busy} onClick={() => doSave(false)}>
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save only'}
              </Button>
              <Button type="button" disabled={!canConnect || busy} onClick={() => doSave(true)}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save & Connect'}
              </Button>
            </>
          ) : (
            <Button type="button" disabled={!canConnect || busy} onClick={doConnect}>
              {connecting ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Connect'}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}

export default QuickConnectModal;
