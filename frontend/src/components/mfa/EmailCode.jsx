import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Loader2, Mail } from 'lucide-react';
import { cn } from '@/lib/utils';

export const RESEND_COOLDOWN_SECONDS = 30;

/**
 * useEmailCode — state for "email me a code": send, a resend cooldown and
 * the messages around it. `send` is the API call (it throws on failure; a
 * 429 means the server's rate limit, which restarts the cooldown).
 *
 * Returns { sent, sending, cooldown, error, notice, send, reset, skip }:
 *   sent     — a code has been sent (or the user said they already have one)
 *   notice   — "sent" after the first send, "resent" after a resend
 *   skip()   — "I already have a code": show the code field without sending
 */
export function useEmailCode(sendFn) {
  const [sent, setSent] = useState(false);
  const [sending, setSending] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState(null);

  useEffect(() => {
    if (cooldown <= 0) return undefined;
    const t = setInterval(() => setCooldown((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(t);
  }, [cooldown]);

  const send = useCallback(async () => {
    if (sending || cooldown > 0) return false;
    const resend = sent;
    setError('');
    setSending(true);
    try {
      await sendFn();
      setSent(true);
      setNotice(resend ? 'resent' : 'sent');
      setCooldown(RESEND_COOLDOWN_SECONDS);
      return true;
    } catch (err) {
      const status = err?.response?.status;
      setError(
        err?.response?.data?.error?.message ||
          (status === 429 ? 'Too many codes requested. Wait a moment and try again.' : err?.message || 'Could not send the code.')
      );
      if (status === 429) setCooldown(RESEND_COOLDOWN_SECONDS);
      return false;
    } finally {
      setSending(false);
    }
  }, [sendFn, sending, cooldown, sent]);

  const reset = useCallback(() => {
    setSent(false);
    setNotice(null);
    setError('');
  }, []);

  const skip = useCallback(() => {
    setSent(true);
    setNotice(null);
    setError('');
  }, []);

  return { sent, sending, cooldown, error, notice, send, reset, skip };
}

/**
 * Before a code is sent: where it goes and a full-width "Send code" button
 * (the primary action of the step), plus "I already have a code".
 */
export function EmailCodeSend({ state, emailHint, buttonClassName }) {
  return (
    <div className="space-y-3">
      <div className="flex items-start gap-3 rounded-md border border-border bg-muted/40 px-3 py-2.5">
        <Mail className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <p className="text-sm text-muted-foreground">
          We&apos;ll email a 6-digit code to <span className="font-medium text-foreground">{emailHint || 'your email address'}</span>.
        </p>
      </div>
      {state.error && (
        <p role="alert" className="text-xs text-destructive">
          {state.error}
        </p>
      )}
      <button
        type="button"
        onClick={state.send}
        disabled={state.sending || state.cooldown > 0}
        className={cn(
          'flex h-9 w-full items-center justify-center gap-2 rounded-md bg-primary text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60',
          buttonClassName
        )}
      >
        {state.sending && <Loader2 className="h-4 w-4 animate-spin" />}
        {state.sending ? 'Sending…' : state.cooldown > 0 ? `Send code (${state.cooldown}s)` : 'Send code'}
      </button>
      <button
        type="button"
        onClick={state.skip}
        className="block w-full text-center text-xs text-muted-foreground hover:text-foreground"
      >
        I already have a code
      </button>
    </div>
  );
}

/** After sending: a confirmation line above the code field. */
export function EmailCodeSentNotice({ state, emailHint }) {
  if (!state.notice) return null;
  return (
    <p role="status" aria-live="polite" className="flex items-start gap-2 text-xs text-emerald-700 dark:text-emerald-400">
      <CheckCircle2 className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span>
        {state.notice === 'resent'
          ? `New code sent to ${emailHint || 'your email'} — use the newest one.`
          : `Code sent to ${emailHint || 'your email'}. It can take a minute to arrive.`}
      </span>
    </p>
  );
}

/** Under the verify button: "Didn't get it? Resend code" with the cooldown. */
export function EmailCodeResend({ state }) {
  return (
    <div className="space-y-1 text-center text-xs text-muted-foreground">
      <p>
        Didn&apos;t get it?{' '}
        {state.cooldown > 0 ? (
          <span className="tabular-nums">Resend in {state.cooldown}s</span>
        ) : (
          <button
            type="button"
            onClick={state.send}
            disabled={state.sending}
            className="inline-flex items-center gap-1 font-medium text-primary hover:underline disabled:opacity-60"
          >
            {state.sending && <Loader2 className="h-3 w-3 animate-spin" />}
            Resend code
          </button>
        )}
      </p>
      {state.error && (
        <p role="alert" className="text-destructive">
          {state.error}
        </p>
      )}
    </div>
  );
}
