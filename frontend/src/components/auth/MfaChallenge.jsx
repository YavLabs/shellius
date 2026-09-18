import { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import api from '@/services/api';
import { sendMfaOtp } from '@/services/mfaService';

/**
 * MfaChallenge — the second-factor step of the login-shaped flow.
 *
 * Shared by Login, AuthCallback (SSO), ResetPassword and AcceptInvite: any
 * endpoint that can return `{ mfaRequired, mfaToken, methods, emailHint }`
 * hands the challenge to this component, which posts to the one shared
 * verification endpoint and reports back the resulting login-shaped
 * response (tokens + user) via `onSuccess`.
 *
 * Props
 *   mfaToken     — from the challenge response
 *   methods      — enrolled factors, e.g. ['totp', 'email']
 *   emailHint    — masked email for the "send code" affordance
 *   onSuccess(data) — called with the verify response's `data` payload
 *   onStartOver()   — user hit "start over" / the challenge is burned
 */
function MfaChallenge({ mfaToken, methods = [], emailHint, onSuccess, onStartOver }) {
  const primaryMethods = methods.filter((m) => m !== 'backup');
  const [method, setMethod] = useState(primaryMethods[0] || methods[0] || 'totp');
  const [code, setCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [attemptsRemaining, setAttemptsRemaining] = useState(null);
  const [fatalMessage, setFatalMessage] = useState('');
  const [otpSent, setOtpSent] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);
  const inputRef = useRef(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, [method]);

  useEffect(() => {
    if (resendCooldown <= 0) return undefined;
    const t = setInterval(() => setResendCooldown((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(t);
  }, [resendCooldown]);

  const maxLen = method === 'backup' ? 12 : 6;

  const handlePaste = (e) => {
    const text = e.clipboardData?.getData('text') || '';
    const cleaned = method === 'backup' ? text.trim() : text.replace(/\D/g, '');
    if (cleaned) {
      e.preventDefault();
      setCode(cleaned.slice(0, maxLen));
    }
  };

  const handleSendOtp = async () => {
    setError('');
    try {
      await sendMfaOtp(mfaToken);
      setOtpSent(true);
      setResendCooldown(30);
    } catch (err) {
      setError(err?.response?.data?.error?.message || err.message || 'Could not send code');
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (fatalMessage) return;
    setError('');
    setSubmitting(true);
    try {
      const res = await api.post('/auth/mfa/verify', { mfaToken, method, code: code.trim() });
      onSuccess?.(res.data?.data || {});
    } catch (err) {
      const errBody = err?.response?.data?.error;
      if (errBody?.code === 'MFA_INVALID') {
        setError(errBody.message || 'Invalid code. Please try again.');
        if (typeof errBody.details?.attemptsRemaining === 'number') {
          setAttemptsRemaining(errBody.details.attemptsRemaining);
        }
        setCode('');
      } else if (errBody?.code === 'MFA_TOO_MANY_ATTEMPTS') {
        setFatalMessage('Too many failed attempts. This verification session has been cancelled.');
      } else if (errBody?.code === 'MFA_CHALLENGE_EXPIRED') {
        setFatalMessage('This verification session has expired.');
      } else {
        setError(errBody?.message || err.message || 'Verification failed');
      }
    } finally {
      setSubmitting(false);
    }
  };

  if (fatalMessage) {
    return (
      <div className="space-y-4">
        <div
          role="alert"
          aria-live="assertive"
          className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {fatalMessage}
        </div>
        <button
          type="button"
          onClick={onStartOver}
          className="flex h-9 w-full items-center justify-center rounded-md bg-primary text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          Start over
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {error && (
        <div
          role="alert"
          aria-live="polite"
          className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
          {typeof attemptsRemaining === 'number' && (
            <span className="block mt-0.5 text-xs">
              {attemptsRemaining} attempt{attemptsRemaining === 1 ? '' : 's'} remaining.
            </span>
          )}
        </div>
      )}
      <p className="text-sm text-muted-foreground">
        Two-factor authentication is required. Enter a verification code to continue.
      </p>

      {primaryMethods.length > 1 && (
        <div className="flex gap-1 rounded-md border border-border p-1" role="tablist" aria-label="Verification method">
          {primaryMethods.includes('totp') && (
            <button
              type="button"
              role="tab"
              aria-selected={method === 'totp'}
              onClick={() => { setMethod('totp'); setCode(''); setError(''); }}
              className={`flex-1 rounded px-2 py-1 text-xs font-medium ${method === 'totp' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'}`}
            >
              Authenticator
            </button>
          )}
          {primaryMethods.includes('email') && (
            <button
              type="button"
              role="tab"
              aria-selected={method === 'email'}
              onClick={() => { setMethod('email'); setCode(''); setError(''); }}
              className={`flex-1 rounded px-2 py-1 text-xs font-medium ${method === 'email' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'}`}
            >
              Email code
            </button>
          )}
        </div>
      )}

      {method === 'email' && (
        <button
          type="button"
          onClick={handleSendOtp}
          disabled={resendCooldown > 0}
          className="text-xs text-primary underline-offset-4 hover:underline disabled:cursor-not-allowed disabled:text-muted-foreground disabled:no-underline"
        >
          {otpSent
            ? resendCooldown > 0
              ? `Code sent to ${emailHint || 'your email'} — resend in ${resendCooldown}s`
              : `Code sent to ${emailHint || 'your email'} — resend`
            : `Send a code to ${emailHint || 'your email'}`}
        </button>
      )}

      <div>
        <label htmlFor="mfa-code" className="mb-1.5 block text-sm font-medium text-foreground">
          {method === 'backup' ? 'Backup code' : 'Verification code'} <span className="text-destructive">*</span>
        </label>
        <input
          id="mfa-code"
          ref={inputRef}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          onPaste={handlePaste}
          placeholder={method === 'totp' ? '6-digit code' : method === 'backup' ? 'xxxx-xxxx' : 'Enter code'}
          autoFocus
          autoComplete="one-time-code"
          inputMode={method === 'backup' ? 'text' : 'numeric'}
          maxLength={maxLen}
          className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm tracking-widest text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
        />
      </div>

      <button
        type="submit"
        disabled={submitting || !code.trim()}
        className="flex h-9 w-full items-center justify-center rounded-md bg-primary text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {submitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
        Verify
      </button>

      <div className="flex items-center justify-between text-xs">
        {method !== 'backup' ? (
          <button
            type="button"
            onClick={() => { setMethod('backup'); setCode(''); setError(''); }}
            className="text-muted-foreground hover:text-foreground"
          >
            Use a backup code
          </button>
        ) : (
          <button
            type="button"
            onClick={() => { setMethod(primaryMethods[0] || 'totp'); setCode(''); setError(''); }}
            className="text-muted-foreground hover:text-foreground"
          >
            Back to verification methods
          </button>
        )}
        <button type="button" onClick={onStartOver} className="text-muted-foreground hover:text-foreground">
          Start over
        </button>
      </div>
    </form>
  );
}

export default MfaChallenge;
