import { useState, useEffect, useCallback } from 'react';
import { ShieldCheck, ShieldOff, Loader2, Copy, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  getMfa,
  beginTotp,
  confirmTotp,
  enableEmailMfa,
  regenerateBackupCodes,
  disableMfa,
} from '@/services/mfaService';

function BackupCodes({ codes }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(codes.join('\n'));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* ignore */
    }
  };
  return (
    <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3">
      <p className="mb-2 text-xs font-medium text-amber-700 dark:text-amber-300">
        Save these backup codes somewhere safe — each works once if you lose your device.
      </p>
      <div className="grid grid-cols-2 gap-1 font-mono text-xs text-foreground">
        {codes.map((c) => (
          <span key={c}>{c}</span>
        ))}
      </div>
      <button onClick={copy} className="mt-2 inline-flex items-center gap-1 text-xs text-primary hover:underline">
        {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />} Copy all
      </button>
    </div>
  );
}

export default function MfaCard() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [enroll, setEnroll] = useState(null); // { qrDataUrl, secret }
  const [code, setCode] = useState('');
  const [backupCodes, setBackupCodes] = useState(null);

  const refresh = useCallback(() => {
    setLoading(true);
    return getMfa()
      .then(setData)
      .catch((e) => setError(e?.response?.data?.error?.message || e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const policy = data?.policy;
  const status = data?.status;

  if (loading) {
    return (
      <div className="rounded-lg border border-border bg-card p-6">
        <div className="h-10 animate-pulse rounded bg-muted" />
      </div>
    );
  }
  if (policy && !policy.enabled) {
    return (
      <div className="rounded-lg border border-border bg-card p-6">
        <h2 className="text-base font-semibold text-foreground">Two-factor authentication</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Two-factor authentication is not enabled for your organization.
        </p>
      </div>
    );
  }

  const startTotp = async () => {
    setBusy(true);
    setError('');
    try {
      setEnroll(await beginTotp());
    } catch (e) {
      setError(e?.response?.data?.error?.message || e.message);
    } finally {
      setBusy(false);
    }
  };

  const finishTotp = async () => {
    setBusy(true);
    setError('');
    try {
      const { backupCodes: bc } = await confirmTotp(code.trim());
      setBackupCodes(bc);
      setEnroll(null);
      setCode('');
      await refresh();
    } catch (e) {
      setError(e?.response?.data?.error?.message || e.message);
    } finally {
      setBusy(false);
    }
  };

  const doEnableEmail = async () => {
    setBusy(true);
    setError('');
    try {
      await enableEmailMfa();
      await refresh();
    } catch (e) {
      setError(e?.response?.data?.error?.message || e.message);
    } finally {
      setBusy(false);
    }
  };

  const doRegen = async () => {
    setBusy(true);
    try {
      const { backupCodes: bc } = await regenerateBackupCodes();
      setBackupCodes(bc);
      await refresh();
    } catch (e) {
      setError(e?.response?.data?.error?.message || e.message);
    } finally {
      setBusy(false);
    }
  };

  const doDisable = async () => {
    if (!window.confirm('Disable two-factor authentication?')) return;
    setBusy(true);
    try {
      await disableMfa();
      await refresh();
    } catch (e) {
      setError(e?.response?.data?.error?.message || e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg border border-border bg-card p-6 space-y-4">
      <div className="flex items-center gap-2">
        {status?.enrolled ? (
          <ShieldCheck className="h-5 w-5 text-emerald-500" />
        ) : (
          <ShieldOff className="h-5 w-5 text-muted-foreground" />
        )}
        <h2 className="text-base font-semibold text-foreground">Two-factor authentication</h2>
      </div>

      {policy?.enforced && !status?.enrolled && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
          Your organization requires two-factor authentication. Please set up a method below.
        </div>
      )}
      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {backupCodes && <BackupCodes codes={backupCodes} />}

      <div className="space-y-1 text-sm text-muted-foreground">
        <p>Authenticator app: {status?.totpEnabled ? <span className="text-emerald-600">enabled</span> : 'not set up'}</p>
        <p>Email code: {status?.emailEnabled ? <span className="text-emerald-600">enabled</span> : 'not set up'}</p>
        {status?.enrolled && <p>Backup codes remaining: {status.backupCodesRemaining}</p>}
      </div>

      {/* TOTP enrollment */}
      {enroll ? (
        <div className="space-y-3 rounded-md border border-border p-4">
          <p className="text-sm text-foreground">Scan this QR code with your authenticator app, then enter the 6-digit code.</p>
          {enroll.qrDataUrl && <img src={enroll.qrDataUrl} alt="TOTP QR" className="h-40 w-40" />}
          <p className="text-xs text-muted-foreground">Or enter this secret manually: <span className="font-mono">{enroll.secret}</span></p>
          <div className="flex gap-2">
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="6-digit code"
              className="h-9 w-32 rounded-md border border-input bg-background px-3 text-sm"
            />
            <Button onClick={finishTotp} disabled={busy || !code.trim()}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Verify & enable'}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {policy?.allowTotp && !status?.totpEnabled && (
            <Button variant="outline" onClick={startTotp} disabled={busy}>
              Set up authenticator app
            </Button>
          )}
          {policy?.allowEmailOtp && !status?.emailEnabled && (
            <Button variant="outline" onClick={doEnableEmail} disabled={busy}>
              Enable email codes
            </Button>
          )}
          {status?.enrolled && (
            <Button variant="outline" onClick={doRegen} disabled={busy}>
              Regenerate backup codes
            </Button>
          )}
          {status?.enrolled && !policy?.enforced && (
            <Button variant="outline" onClick={doDisable} disabled={busy}>
              Disable 2FA
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
