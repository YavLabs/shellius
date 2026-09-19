import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import TotpEnrollPanel from '@/components/mfa/TotpEnrollPanel';
import BackupCodesPanel from '@/components/mfa/BackupCodesPanel';
import { useAuth } from '@/context/AuthContext';
import { getMfa, beginTotp, confirmTotp, enableEmailMfa } from '@/services/mfaService';
import AuthShell from '@/components/auth/AuthShell';

/**
 * MfaSetup — forced-enrollment screen. Rendered when the org enforces MFA
 * and the signed-in user hasn't enrolled a factor yet (user.mfaSetupRequired).
 * Lives inside ProtectedRoute but outside AppLayout — a focused, full-screen
 * card like Login, with nothing else reachable until setup is done.
 */
function MfaSetup() {
  const navigate = useNavigate();
  const { user, refreshUser, logout } = useAuth();

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [enroll, setEnroll] = useState(null); // { qrDataUrl, secret }
  const [busy, setBusy] = useState(false);
  const [totpError, setTotpError] = useState('');
  const [emailError, setEmailError] = useState('');
  const [backupCodes, setBackupCodes] = useState(null);
  const [finishing, setFinishing] = useState(false);

  const refresh = useCallback(() => {
    setLoading(true);
    return getMfa()
      .then(setData)
      .catch((e) => setLoadError(e?.response?.data?.error?.message || e.message || 'Failed to load MFA options'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const policy = data?.policy;

  const startTotp = async () => {
    setBusy(true);
    setTotpError('');
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
      setBackupCodes(bc || null);
      setEnroll(null);
      await refresh();
    } catch (e) {
      setTotpError(e?.response?.data?.error?.message || e.message);
    } finally {
      setBusy(false);
    }
  };

  const doEnableEmail = async () => {
    setBusy(true);
    setEmailError('');
    try {
      await enableEmailMfa();
      await refresh();
    } catch (e) {
      setEmailError(e?.response?.data?.error?.message || e.message);
    } finally {
      setBusy(false);
    }
  };

  const handleContinue = async () => {
    setFinishing(true);
    try {
      await refreshUser();
      navigate('/dashboard', { replace: true });
    } finally {
      setFinishing(false);
    }
  };

  const handleSignOut = async () => {
    await logout();
    navigate('/login', { replace: true });
  };

  const enrolled = !!data?.status?.enrolled;

  return (
    <AuthShell>
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-semibold">Set up two-factor authentication</h1>
        </div>

        <div className="rounded-lg border border-border bg-card p-6 shadow-sm space-y-4">
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
            {user?.orgName ? `${user.orgName} requires` : 'Your organization requires'} two-factor
            authentication. You won&apos;t be able to use Shellius until you finish setting up a
            method below.
          </div>

          {loading ? (
            <div className="h-24 animate-pulse rounded bg-muted" />
          ) : loadError ? (
            <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {loadError}
            </div>
          ) : enrolled ? (
            <div className="space-y-4">
              <div className="flex items-center gap-2 text-sm text-emerald-600 dark:text-emerald-400">
                <ShieldCheck className="h-5 w-5" />
                Two-factor authentication is enabled.
              </div>
              {backupCodes && <BackupCodesPanel codes={backupCodes} />}
              <Button className="w-full" onClick={handleContinue} disabled={finishing}>
                {finishing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Continue
              </Button>
            </div>
          ) : enroll ? (
            <TotpEnrollPanel enroll={enroll} onConfirm={finishTotp} busy={busy} error={totpError} />
          ) : (
            <div className="space-y-3">
              {policy?.allowTotp && (
                <Button variant="outline" className="w-full" onClick={startTotp} disabled={busy}>
                  Set up an authenticator app
                </Button>
              )}
              {policy?.allowEmailOtp && (
                <Button variant="outline" className="w-full" onClick={doEnableEmail} disabled={busy}>
                  Use email codes instead
                </Button>
              )}
              {emailError && <p className="text-xs text-destructive">{emailError}</p>}
              {!policy?.allowTotp && !policy?.allowEmailOtp && (
                <p className="text-sm text-muted-foreground">
                  No verification methods are currently available. Contact your administrator.
                </p>
              )}
            </div>
          )}

          <div className="border-t border-border pt-4 text-center">
            <button
              type="button"
              onClick={handleSignOut}
              className="text-xs text-muted-foreground hover:text-foreground underline-offset-4 hover:underline"
            >
              Sign out
            </button>
          </div>
        </div>
      </div>
    </AuthShell>
  );
}

export default MfaSetup;
