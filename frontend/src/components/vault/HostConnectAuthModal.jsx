import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import Modal from '@/components/shared/Modal';
import { Button } from '@/components/ui/button';
import PasswordInput from '@/components/ui/PasswordInput';
import PrivateKeyInput from '@/components/keystore/PrivateKeyInput';
import { connectVaultHost } from '@/services/vaultService';

const inputCls =
  'h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring';
const labelCls = 'mb-1.5 block text-sm font-medium text-foreground';

/**
 * HostConnectAuthModal — one-off password/key prompt for a My hosts entry
 * that has no linked identity ("Ask each time"). Nothing entered here is
 * ever stored — it's sent once with the connect call
 * (docs/personal-vault.md: `POST /vault/hosts/:id/connect`).
 */
function HostConnectAuthModal({ open, onClose, host, onConnected }) {
  const [authTab, setAuthTab] = useState('password');
  const [password, setPassword] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [keyPassphrase, setKeyPassphrase] = useState('');
  const [keyAlsoPassword, setKeyAlsoPassword] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setAuthTab('password');
    setPassword('');
    setPrivateKey('');
    setKeyPassphrase('');
    setKeyAlsoPassword('');
    setError('');
  }, [open]);

  const canConnect = authTab === 'password' ? !!password : !!privateKey.trim();

  const handleConnect = async () => {
    setError('');
    setConnecting(true);
    try {
      const auth =
        authTab === 'password'
          ? { type: 'password', password }
          : {
              type: 'key',
              privateKey: privateKey.trim(),
              passphrase: keyPassphrase || undefined,
              password: keyAlsoPassword || undefined,
            };
      const resp = await connectVaultHost(host.id, { auth });
      onConnected?.(resp);
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message || 'Failed to connect');
    } finally {
      setConnecting(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={`Connect — ${host?.name || ''}`} size="sm">
      <div className="space-y-4">
        <p className="text-xs text-muted-foreground">
          This host has no saved identity. Enter credentials for this connection only — nothing is stored.
        </p>

        {error && (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        <div>
          <div className="flex gap-4 border-b border-border">
            {[
              { value: 'password', label: 'Password' },
              { value: 'key', label: 'Private key' },
            ].map((t) => (
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
            {authTab === 'password' ? (
              <PasswordInput
                className={inputCls}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Password"
                autoComplete="off"
                autoFocus
              />
            ) : (
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
                    <span className="font-normal text-muted-foreground">(optional)</span>
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
          </div>
        </div>

        <div data-sheet-footer className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" disabled={!canConnect || connecting} onClick={handleConnect}>
            {connecting ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Connect'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export default HostConnectAuthModal;
