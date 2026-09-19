import { useState } from 'react';
import { Check, Copy, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * TotpEnrollPanel — QR code + secret + confirmation code input. Shared by the
 * forced-enrollment page (MfaSetup) and the self-service Profile MFA card.
 *
 * `enroll` is the { qrDataUrl, secret } payload from POST /mfa/totp/begin.
 * `onConfirm(code)` should call POST /mfa/totp/confirm and handle the result.
 * `layout`: 'stacked' (auth pages — everything centred in one column) or
 * 'split' (Profile — QR on the left, steps on the right; stacks on mobile).
 */
export default function TotpEnrollPanel({ enroll, onConfirm, busy, error, replacing, layout = 'split' }) {
  const [code, setCode] = useState('');
  const [copied, setCopied] = useState(false);
  const stacked = layout === 'stacked';

  // Group the base32 secret in fours so it's easy to read and type.
  const groupedSecret = (enroll?.secret || '').replace(/(.{4})(?=.)/g, '$1 ');

  const copySecret = async () => {
    try {
      await navigator.clipboard.writeText(enroll.secret);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — the secret is still selectable */
    }
  };

  const qr = enroll?.qrDataUrl && (
    <div className={cn('w-fit shrink-0 rounded-lg bg-white p-2.5 shadow-sm ring-1 ring-black/5', stacked && 'mx-auto')}>
      <img src={enroll.qrDataUrl} alt="Authenticator app QR code" className="block h-40 w-40" />
    </div>
  );

  const secret = enroll?.secret && (
    <div className={cn('space-y-1.5', stacked && 'text-center')}>
      <p className="text-xs text-muted-foreground">Can't scan it? Enter this key instead:</p>
      <button
        type="button"
        onClick={copySecret}
        title="Copy key"
        className={cn(
          'group inline-flex max-w-full items-center gap-2 rounded-md bg-muted px-3 py-1.5 font-mono text-xs text-foreground transition-colors hover:bg-accent',
          stacked && 'mx-auto'
        )}
      >
        <span className="break-all text-left">{groupedSecret}</span>
        {copied ? (
          <Check className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
        ) : (
          <Copy className="h-3.5 w-3.5 shrink-0 text-muted-foreground group-hover:text-foreground" />
        )}
      </button>
    </div>
  );

  const form = (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onConfirm(code.trim());
      }}
      className={cn('gap-2', stacked ? 'flex flex-col' : 'flex flex-col sm:flex-row')}
    >
      <label htmlFor="totp-confirm-code" className="sr-only">
        Confirmation code
      </label>
      <input
        id="totp-confirm-code"
        value={code}
        onChange={(e) => setCode(e.target.value)}
        placeholder="6-digit code"
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={10}
        autoFocus
        className={cn(
          'h-10 rounded-md border border-input bg-background px-3 font-mono text-sm tracking-[0.2em] placeholder:font-sans placeholder:tracking-normal',
          stacked ? 'w-full text-center' : 'w-full sm:w-44'
        )}
      />
      <Button type="submit" className={cn('h-10', stacked && 'w-full')} disabled={busy || !code.trim()}>
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Verify & enable'}
      </Button>
    </form>
  );

  const note = replacing && (
    <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
      Your current authenticator keeps working until you confirm this new one.
    </p>
  );

  const errorLine = error && <p className={cn('text-xs text-destructive', stacked && 'text-center')}>{error}</p>;

  if (stacked) {
    return (
      <div className="space-y-4 rounded-lg border border-border p-5">
        {note}
        <p className="text-center text-sm text-foreground">
          Scan this QR code with your authenticator app, then enter the 6-digit code it shows.
        </p>
        {qr}
        {secret}
        {errorLine}
        {form}
      </div>
    );
  }

  return (
    <div className="space-y-4 rounded-lg border border-border p-4">
      {note}
      <div className="flex flex-col gap-5 sm:flex-row sm:items-start">
        {qr}
        <div className="min-w-0 flex-1 space-y-4">
          <ol className="space-y-1 text-sm text-foreground">
            <li>1. Scan the QR code with your authenticator app.</li>
            <li>2. Enter the 6-digit code it shows.</li>
          </ol>
          {secret}
          {errorLine}
          {form}
        </div>
      </div>
    </div>
  );
}
