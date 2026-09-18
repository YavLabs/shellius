import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronDown, ChevronRight, Clock, Loader2, AlertTriangle } from 'lucide-react';
import Modal from '@/components/shared/Modal';
import { Button } from '@/components/ui/button';
import PasswordInput from '@/components/ui/PasswordInput';
import SearchableSelect from '@/components/ui/SearchableSelect';
import PrivateKeyInput from '@/components/keystore/PrivateKeyInput';
import SaveServerFields from './SaveServerFields';
import { createQuickConnectTicket, saveQuickConnectServer, getHistory } from '@/services/quickConnectService';
import { listCredentials } from '@/services/keystoreService';
import { useAuth } from '@/context/AuthContext';
import { roleAtLeast } from '@/lib/permissions';
import { openBlankTerminalTab, openTicketTerminal, closeBlankTerminalTab } from '@/lib/quickConnectLaunch';

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

function QuickConnectModal({ open, onClose, prefill }) {
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
  const [keyAlsoPassword, setKeyAlsoPassword] = useState('');
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
    setHost(prefill?.host || '');
    setPort(prefill?.port ? String(prefill.port) : '22');
    setUsername(prefill?.username || '');
    setAuthTab(prefill?.authTab || 'password');
    setPassword('');
    setPrivateKey('');
    setKeyPassphrase('');
    setKeyAlsoPassword('');
    setCredentialId(prefill?.credentialId || '');
    setAdvancedOpen(false);
    setExpectedHostKey('');
    setSaveOn(false);
    setSaveValues({ identityMode: 'existing', environment: 'dev' });
    setError(null);
    getHistory({ limit: 8 })
      .then(setRecent)
      .catch(() => setRecent([]));
    listCredentials()
      .then(setIdentities)
      .catch(() => setIdentities([]));
  }, [open, prefill]);

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
    if (r.authType === 'credential' && r.credential) {
      setAuthTab('credential');
      setCredentialId(r.credential.id);
    } else if (r.authType === 'key') {
      setAuthTab('key');
    } else {
      setAuthTab('password');
    }
  };

  const buildAuth = () => {
    if (authTab === 'password') return { type: 'password', password };
    if (authTab === 'key') {
      return {
        type: 'key',
        privateKey: privateKey.trim(),
        passphrase: keyPassphrase || undefined,
        password: keyAlsoPassword || undefined,
      };
    }
    return { type: 'credential', credentialId };
  };

  const canConnect = useMemo(() => {
    if (!host.trim()) return false;
    if (authTab === 'password') return !!username.trim() && !!password;
    if (authTab === 'key') return !!username.trim() && !!privateKey.trim();
    return !!credentialId; // username may be inferred from identity
  }, [host, authTab, username, password, privateKey, credentialId]);

  const doConnect = async () => {
    setError(null);
    setConnecting(true);
    // Open a blank tab synchronously (before the await) so popup blockers
    // don't kick in once we're back from the network call.
    const win = openBlankTerminalTab();
    try {
      const resp = await createQuickConnectTicket({
        host: host.trim(),
        port: Number(port) || 22,
        username: username.trim() || undefined,
        auth: buildAuth(),
        expectedHostKey: expectedHostKey.trim() || undefined,
      });
      const label = `${username.trim() || 'user'}@${host.trim()}`;
      openTicketTerminal(win, { ticket: resp.ticket, label });
      onClose();
    } catch (err) {
      closeBlankTerminalTab(win);
      const code = err.response?.data?.error?.code;
      if (code === 'PROD_HOST_REQUIRES_APPROVAL') {
        setError({
          message:
            err.response?.data?.error?.message ||
            'This host matches a production server and requires the access-request flow.',
          serverId:
            err.response?.data?.error?.serverId || err.response?.data?.error?.details?.serverId,
        });
      } else if (code === 'TARGET_NOT_ALLOWED') {
        setError({
          message:
            err.response?.data?.error?.message ||
            "This address can't be targeted — loopback, link-local and cloud metadata addresses are blocked.",
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
              {recent.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => applyRecent(r)}
                  className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/40 px-2.5 py-1 font-mono text-xs text-foreground hover:bg-accent"
                >
                  <span
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                      r.lastStatus === 'connected' ? 'bg-emerald-500' : 'bg-red-500'
                    }`}
                  />
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
              <div className="space-y-3">
                <PrivateKeyInput
                  privateKey={privateKey}
                  onPrivateKeyChange={setPrivateKey}
                  passphrase={keyPassphrase}
                  onPassphraseChange={setKeyPassphrase}
                  rows={4}
                  showHint={false}
                />
                <div>
                  <label className={labelCls}>
                    Also send a password{' '}
                    <span className="font-normal text-muted-foreground">
                      (optional — for servers requiring both a key and a password)
                    </span>
                  </label>
                  <PasswordInput
                    className={inputCls}
                    value={keyAlsoPassword}
                    onChange={(e) => setKeyAlsoPassword(e.target.value)}
                    placeholder="Password"
                    autoComplete="off"
                  />
                </div>
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
