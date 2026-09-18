import { useState, useEffect, useCallback } from 'react';
import { ShieldCheck, ShieldOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import TotpEnrollPanel from '@/components/mfa/TotpEnrollPanel';
import BackupCodesPanel from '@/components/mfa/BackupCodesPanel';
import VerifyAction from '@/components/mfa/VerifyAction';
import {
  getMfa,
  beginTotp,
  confirmTotp,
  enableEmailMfa,
  regenerateBackupCodes,
  disableMfa,
} from '@/services/mfaService';

/**
 * MfaCard — self-service two-factor management on the Profile page.
 * Disabling a factor or regenerating backup codes now requires proving
 * you're still you (a code from an enrolled method, or your password).
 */
export default function MfaCard({ hasPassword }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const [enroll, setEnroll] = useState(null); // { qrDataUrl, secret }
  const [replacing, setReplacing] = useState(false);
  const [totpError, setTotpError] = useState('');

  const [backupCodes, setBackupCodes] = useState(null);
  const [pendingAction, setPendingAction] = useState(null); // 'disable' | 'regenerate'
  const [verifyError, setVerifyError] = useState('');

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

  const enrolledMethods = [
    status?.totpEnabled && 'totp',
    status?.emailEnabled && 'email',
    status?.backupCodesRemaining > 0 && 'backup',
  ].filter(Boolean);

  const startTotp = async (isReplace) => {
    setBusy(true);
    setTotpError('');
    setReplacing(!!isReplace);
    try {
      setEnroll(await beginTotp());
    } catch (e) {
      setTotpError(e?.response?.data?.error?.message || e.message);
    } finally {
      setBusy(false);
    }
  };

  const finishTotp = async (code) => {
    setBusy(true);
    setTotpError('');
    try {
      const { backupCodes: bc } = await confirmTotp(code);
      if (bc) setBackupCodes(bc);
      setEnroll(null);
      setReplacing(false);
      await refresh();
    } catch (e) {
      setTotpError(e?.response?.data?.error?.message || e.message);
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

  const handleVerify = async (verification) => {
    setBusy(true);
    setVerifyError('');
    try {
      if (pendingAction === 'regenerate') {
        const { backupCodes: bc } = await regenerateBackupCodes(verification);
        setBackupCodes(bc);
      } else if (pendingAction === 'disable') {
        await disableMfa(verification);
        setBackupCodes(null);
      }
      setPendingAction(null);
      await refresh();
    } catch (e) {
      setVerifyError(e?.response?.data?.error?.message || e.message || 'Verification failed');
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

      {backupCodes && <BackupCodesPanel codes={backupCodes} />}

      <div className="space-y-1 text-sm text-muted-foreground">
        <p>Authenticator app: {status?.totpEnabled ? <span className="text-emerald-600">enabled</span> : 'not set up'}</p>
        <p>Email code: {status?.emailEnabled ? <span className="text-emerald-600">enabled</span> : 'not set up'}</p>
        {status?.enrolled && <p>Backup codes remaining: {status.backupCodesRemaining}</p>}
      </div>

      {enroll ? (
        <TotpEnrollPanel enroll={enroll} onConfirm={finishTotp} busy={busy} error={totpError} replacing={replacing} />
      ) : pendingAction ? (
        <VerifyAction
          enrolledMethods={enrolledMethods}
          hasPassword={hasPassword}
          busy={busy}
          error={verifyError}
          onVerify={handleVerify}
          onCancel={() => { setPendingAction(null); setVerifyError(''); }}
        />
      ) : (
        <div className="flex flex-wrap gap-2">
          {policy?.allowTotp && !status?.totpEnabled && (
            <Button variant="outline" onClick={() => startTotp(false)} disabled={busy}>
              Set up authenticator app
            </Button>
          )}
          {policy?.allowTotp && status?.totpEnabled && (
            <Button variant="outline" onClick={() => startTotp(true)} disabled={busy}>
              Replace authenticator
            </Button>
          )}
          {policy?.allowEmailOtp && !status?.emailEnabled && (
            <Button variant="outline" onClick={doEnableEmail} disabled={busy}>
              Enable email codes
            </Button>
          )}
          {status?.enrolled && (
            <Button variant="outline" onClick={() => setPendingAction('regenerate')} disabled={busy}>
              Regenerate backup codes
            </Button>
          )}
          {status?.enrolled && !policy?.enforced && (
            <Button variant="outline" onClick={() => setPendingAction('disable')} disabled={busy}>
              Disable 2FA
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
