import { useState } from 'react';
import { AlertTriangle, ArrowLeft, CheckCircle2, Loader2, ShieldAlert, Terminal } from 'lucide-react';
import Modal from '@/components/shared/Modal';
import { Button } from '@/components/ui/button';
import EnvironmentBadge from '@/components/shared/EnvironmentBadge';
import { EmailCodeResend, useEmailCode } from '@/components/mfa/EmailCode';
import { startBreakGlass, verifyBreakGlass } from '@/services/accessRequestService';
import { getMfa } from '@/services/mfaService';
import { useTerminalWorkspace } from '@/context/TerminalWorkspaceContext';
import { formatDateTime } from '@/utils/time';

const MIN_REASON_LENGTH = 20;

const METHOD_LABELS = {
  totp: 'Authenticator app code',
  email: 'Emailed code',
};

/** Turns an API error from either break-glass endpoint into copy that makes
 * sense to someone mid-incident, not a raw server message. */
function describeBreakGlassError(err) {
  const status = err?.response?.status;
  const code = err?.response?.data?.error?.code;
  const serverMessage = err?.response?.data?.error?.message;

  if (status === 404) {
    return 'This server is no longer available to you — it may have been removed or is outside your access scope.';
  }
  if (code === 'BREAK_GLASS_NOT_AUTHORIZED') {
    return serverMessage || 'No break-glass policy authorizes emergency access to this server for you.';
  }
  if (code === 'BREAK_GLASS_PROD_BYPASS_DISABLED') {
    return 'Your organization requires approval for all production access, including break-glass — this cannot be bypassed.';
  }
  if (code === 'BREAK_GLASS_ALREADY_ACTIVE') {
    return serverMessage || 'Break-glass access to this server is already active.';
  }
  if (code === 'EMAIL_NOT_DELIVERED' || status === 503) {
    return "Email delivery isn't configured for this organization, so a code can't be emailed right now. Contact an administrator or use an authenticator app instead.";
  }
  if (code === 'BREAK_GLASS_CHALLENGE_EXPIRED') {
    return 'This verification has expired (or was already used) — start again.';
  }
  if (code === 'BREAK_GLASS_TOO_MANY_ATTEMPTS' || status === 429) {
    return 'Too many incorrect codes — this verification has been cancelled. Start again.';
  }
  if (code === 'BREAK_GLASS_INVALID_CODE') {
    const remaining = err?.response?.data?.error?.details?.attemptsRemaining;
    return typeof remaining === 'number'
      ? `Incorrect code — ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.`
      : 'Incorrect code.';
  }
  return serverMessage || 'Something went wrong — please try again.';
}

/**
 * BreakGlassModal — the only entry point in the product for emergency
 * (`access.break_glass`) access. Two steps, both audited server-side:
 *   1. reason  — required, >= 20 chars; explicit notice this is audited and
 *      notifies the server's approvers.
 *   2. verify  — a step-up code (authenticator app or emailed), matching
 *      whatever `startBreakGlass` returns; if the user has both factors
 *      enrolled they choose between them first.
 * On success, shows exactly what was granted and links straight to Connect.
 */
function BreakGlassModal({ open, onClose, server }) {
  const { openTabForAccessRequest } = useTerminalWorkspace();

  const [step, setStep] = useState('reason'); // 'reason' | 'choose-method' | 'verify' | 'success'
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState('');
  const [starting, setStarting] = useState(false);

  const [challenge, setChallenge] = useState(null); // { challengeId, method, emailHint, expiresIn }
  const [code, setCode] = useState('');
  const [verifyError, setVerifyError] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [grantedAr, setGrantedAr] = useState(null);

  // Only asked when the user has both factors enrolled (getMfa checked once
  // per open, right before starting the challenge).
  const email = useEmailCode(async () => {
    const res = await startBreakGlass({ serverId: server.id, reason: reason.trim(), method: 'email' });
    setChallenge(res);
    setCode('');
    setVerifyError('');
  });

  const reset = () => {
    setStep('reason');
    setReason('');
    setReasonError('');
    setStarting(false);
    setChallenge(null);
    setCode('');
    setVerifyError('');
    setVerifying(false);
    setGrantedAr(null);
    email.reset();
  };

  const handleClose = () => {
    reset();
    onClose?.();
  };

  const beginChallenge = async (method) => {
    setStarting(true);
    setReasonError('');
    setVerifyError('');
    try {
      const res = await startBreakGlass({
        serverId: server.id,
        reason: reason.trim(),
        ...(method ? { method } : {}),
      });
      setChallenge(res);
      setCode('');
      if (res.method === 'email') email.skip(); // already sent by start() itself
      setStep('verify');
    } catch (err) {
      setReasonError(describeBreakGlassError(err));
    } finally {
      setStarting(false);
    }
  };

  const handleReasonContinue = async () => {
    const trimmed = reason.trim();
    if (trimmed.length < MIN_REASON_LENGTH) {
      setReasonError(`Reason must be at least ${MIN_REASON_LENGTH} characters.`);
      return;
    }
    setStarting(true);
    setReasonError('');
    try {
      const mfa = await getMfa();
      const bothEnrolled = !!(mfa?.status?.totpEnabled && mfa?.status?.emailEnabled);
      setStarting(false);
      if (bothEnrolled) {
        setStep('choose-method');
      } else {
        await beginChallenge();
      }
    } catch {
      // Can't tell which factors are enrolled — let the server pick.
      await beginChallenge();
    }
  };

  const handleVerify = async (e) => {
    e.preventDefault();
    if (!challenge?.challengeId || !code.trim()) return;
    setVerifying(true);
    setVerifyError('');
    try {
      const ar = await verifyBreakGlass({ challengeId: challenge.challengeId, code: code.trim() });
      setGrantedAr(ar);
      setStep('success');
    } catch (err) {
      const message = describeBreakGlassError(err);
      const code_ = err?.response?.data?.error?.code;
      if (code_ === 'BREAK_GLASS_CHALLENGE_EXPIRED' || code_ === 'BREAK_GLASS_TOO_MANY_ATTEMPTS' || err?.response?.status === 429) {
        // Unrecoverable — the challenge is burned. Back to the top with the
        // reason preserved so they don't have to retype it.
        setChallenge(null);
        setStep('reason');
      }
      setVerifyError(message);
    } finally {
      setVerifying(false);
    }
  };

  const handleConnect = () => {
    if (!grantedAr) return;
    openTabForAccessRequest(grantedAr, {
      label: server?.displayName || server?.hostname,
      env: server?.environment,
      focus: true,
    });
    handleClose();
  };

  const reasonCount = reason.trim().length;
  const reasonOk = reasonCount >= MIN_REASON_LENGTH;

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title={
        <span className="flex items-center gap-2">
          <ShieldAlert className="h-4 w-4 text-destructive" />
          <span>Break-glass access</span>
          {server && (
            <span className="flex items-center gap-1.5 text-sm font-normal text-muted-foreground">
              — {server.displayName || server.hostname}
              {server.environment && <EnvironmentBadge environment={server.environment} />}
            </span>
          )}
        </span>
      }
      size="md"
    >
      {step === 'reason' && (
        <div className="space-y-4">
          <div className="flex items-start gap-2.5 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2.5 text-destructive">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <p className="text-sm">
              This bypasses the normal approval workflow. It is fully audited and the server&apos;s
              approvers are notified immediately with your reason. Only use this for a genuine
              emergency.
            </p>
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium text-foreground">
              Reason <span className="text-destructive">*</span>
            </label>
            <textarea
              rows={4}
              autoFocus
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="What's the emergency? Be specific — this is recorded in the audit log and sent to approvers."
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <div className="mt-1 flex items-center justify-between text-xs">
              <span className={reasonOk ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'}>
                {reasonCount} / {MIN_REASON_LENGTH} characters minimum
              </span>
            </div>
          </div>

          {reasonError && <p className="text-xs text-destructive">{reasonError}</p>}

          <div data-sheet-footer className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="outline" onClick={handleClose} disabled={starting}>
              Cancel
            </Button>
            <Button type="button" variant="destructive" onClick={handleReasonContinue} disabled={!reasonOk || starting}>
              {starting ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Continue'}
            </Button>
          </div>
        </div>
      )}

      {step === 'choose-method' && (
        <div className="space-y-4">
          <p className="text-sm text-foreground">
            You have both an authenticator app and email verification set up. Which do you want to
            use?
          </p>
          {reasonError && <p className="text-xs text-destructive">{reasonError}</p>}
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Button type="button" variant="outline" className="h-11" onClick={() => beginChallenge('totp')} disabled={starting}>
              Authenticator app
            </Button>
            <Button type="button" variant="outline" className="h-11" onClick={() => beginChallenge('email')} disabled={starting}>
              Email a code
            </Button>
          </div>
          <button
            type="button"
            onClick={() => setStep('reason')}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            disabled={starting}
          >
            <ArrowLeft className="h-3 w-3" /> Back
          </button>
        </div>
      )}

      {step === 'verify' && challenge && (
        <form onSubmit={handleVerify} className="space-y-4">
          <p className="text-sm text-foreground">
            Enter the {METHOD_LABELS[challenge.method] || 'verification code'} to confirm and grant
            access.
          </p>
          {challenge.method === 'email' && (
            <p className="text-xs text-muted-foreground">
              A code was emailed to <span className="font-medium text-foreground">{challenge.emailHint || 'your email address'}</span>.
              It can take a minute to arrive.
            </p>
          )}
          {verifyError && <p className="text-xs text-destructive">{verifyError}</p>}
          <div>
            <label className="mb-1.5 block text-sm font-medium text-foreground">Verification code</label>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="6-digit code"
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
              className="h-10 w-full rounded-md border border-input bg-background px-3 text-center text-lg tracking-[0.3em] text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          {challenge.method === 'email' && <EmailCodeResend state={email} />}
          <div data-sheet-footer className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="outline" onClick={() => setStep('reason')} disabled={verifying}>
              <ArrowLeft className="mr-1.5 h-3.5 w-3.5" /> Back
            </Button>
            <Button type="submit" variant="destructive" disabled={!code.trim() || verifying}>
              {verifying ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Verify and grant access'}
            </Button>
          </div>
        </form>
      )}

      {step === 'success' && grantedAr && (
        <div className="space-y-4">
          <div className="flex items-start gap-2.5 rounded-md border border-emerald-500/50 bg-emerald-500/10 px-3 py-2.5 text-emerald-800 dark:text-emerald-200">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
            <p className="text-sm font-medium">Break-glass access granted.</p>
          </div>
          <dl className="space-y-1.5 text-sm">
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">Server</dt>
              <dd className="text-foreground">{grantedAr.server?.hostname || server?.hostname}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">Principal</dt>
              <dd className="font-mono text-foreground">{grantedAr.requestedPrincipal}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">Expires</dt>
              <dd className="text-foreground">{formatDateTime(grantedAr.expiresAt)}</dd>
            </div>
          </dl>
          <p className="text-xs text-muted-foreground">
            The server&apos;s approvers have been notified. This access ends automatically at the
            time above.
          </p>
          <div data-sheet-footer className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="outline" onClick={handleClose}>
              Close
            </Button>
            <Button type="button" onClick={handleConnect}>
              <Terminal className="mr-1.5 h-4 w-4" /> Connect now
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

export default BreakGlassModal;
