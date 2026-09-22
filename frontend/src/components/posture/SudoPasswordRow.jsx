import { useState } from 'react';
import { KeyRound, Loader2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import PasswordInput from '@/components/ui/PasswordInput';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/context/AuthContext';
import { saveSudoPassword, forgetSudoPassword } from '@/services/serverService';

/**
 * "Sudo for installs" — the one place a host's saved sudo password is seen
 * and managed.
 *
 * A certificate install logs in with no password, so a non-root SSH user's
 * sudo had to be answered by whoever ran the install, every single time.
 * Saving it (encrypted, in the org Keystore) is what lets a reinstall run
 * with nothing typed. The password itself is write-only: nothing here, or
 * anywhere, ever shows it back.
 */
export default function SudoPasswordRow({ serverId, install, onChanged }) {
  const { can } = useAuth();
  const canManage = can('servers.manage_credentials') && can('keystore.manage');
  const [editing, setEditing] = useState(false);
  const [confirmForget, setConfirmForget] = useState(false);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null); // { tone, text }

  if (!install?.canInstall) return null;
  // root needs no sudo; saying "not saved" there would invite a pointless save.
  if (install.sshUser === 'root') return null;

  const saved = install.savedSudo;

  const handleSave = async () => {
    if (!password) return;
    setBusy(true);
    setNotice(null);
    try {
      const res = await saveSudoPassword(serverId, password);
      setPassword('');
      setEditing(false);
      setNotice({
        tone: 'ok',
        text: res.created
          ? `Saved to the Keystore as “${res.name}”. Installs on this host use it automatically.`
          : 'Sudo password updated.',
      });
      onChanged?.();
    } catch (err) {
      setNotice({ tone: 'error', text: err.response?.data?.error?.message || 'Could not save the sudo password.' });
    } finally {
      setBusy(false);
    }
  };

  const handleForget = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const res = await forgetSudoPassword(serverId);
      setConfirmForget(false);
      setNotice({
        tone: 'ok',
        text: res.deletedIdentity
          ? 'Forgotten, and removed from the Keystore. The next install as this user will ask for it.'
          : 'Forgotten for this host. The Keystore identity is still used elsewhere, so it was kept.',
      });
      onChanged?.();
    } catch (err) {
      setNotice({ tone: 'error', text: err.response?.data?.error?.message || 'Could not forget the sudo password.' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="py-1.5">
      <div className="flex items-start justify-between gap-4">
        <span className="pt-0.5 text-xs text-muted-foreground">Sudo for installs</span>
        <div className="min-w-0 text-right">
          {saved ? (
            <span className="inline-flex items-center gap-1.5 text-sm text-foreground">
              <KeyRound className="h-3.5 w-3.5 text-emerald-500" aria-hidden="true" />
              Saved
              {can('keystore.view') ? (
                <Link to="/keystore" className="truncate text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
                  {saved.name}
                </Link>
              ) : (
                <span className="truncate text-xs text-muted-foreground">{saved.name}</span>
              )}
            </span>
          ) : (
            <span className="text-sm text-muted-foreground">
              Not saved — installs as <span className="font-mono">{install.sshUser}</span> will ask for it
            </span>
          )}
          {canManage && !editing && !confirmForget && (
            <div className="mt-1 flex justify-end gap-3 text-xs">
              <button type="button" onClick={() => { setEditing(true); setNotice(null); }} className="font-medium text-primary hover:underline">
                {saved ? 'Change' : 'Save one…'}
              </button>
              {saved && (
                <button type="button" onClick={() => { setConfirmForget(true); setNotice(null); }} className="font-medium text-destructive hover:underline">
                  Forget
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {editing && (
        <div className="mt-2 space-y-2">
          <PasswordInput
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={`sudo password for ${install.sshUser}`}
            autoComplete="new-password"
            autoFocus
            onKeyDown={(e) => { if (e.key === 'Enter') handleSave(); }}
          />
          <p className="text-xs text-muted-foreground">
            Stored encrypted in the org Keystore and only ever used to answer <span className="font-mono">sudo</span> during an
            install on this host. It is never shown again.
          </p>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => { setEditing(false); setPassword(''); }} disabled={busy}>
              Cancel
            </Button>
            <Button size="sm" onClick={handleSave} disabled={!password || busy}>
              {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              Save
            </Button>
          </div>
        </div>
      )}

      {confirmForget && (
        <div className="mt-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs">
          <p className="text-foreground">
            Forget the saved sudo password? The next install on this host as <span className="font-mono">{install.sshUser}</span>{' '}
            will stop and ask for it.
          </p>
          <div className="mt-2 flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setConfirmForget(false)} disabled={busy}>
              Keep it
            </Button>
            <Button size="sm" variant="destructive" onClick={handleForget} disabled={busy}>
              {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              Forget
            </Button>
          </div>
        </div>
      )}

      {notice && (
        <p role="status" className={`mt-1.5 text-right text-xs ${notice.tone === 'error' ? 'text-destructive' : 'text-emerald-600 dark:text-emerald-400'}`}>
          {notice.text}
        </p>
      )}
    </div>
  );
}
