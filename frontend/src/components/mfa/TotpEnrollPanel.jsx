import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * TotpEnrollPanel — QR code + secret + confirmation code input. Shared by the
 * forced-enrollment page (MfaSetup) and the self-service Profile MFA card.
 *
 * `enroll` is the { qrDataUrl, secret } payload from POST /mfa/totp/begin.
 * `onConfirm(code)` should call POST /mfa/totp/confirm and handle the result.
 */
export default function TotpEnrollPanel({ enroll, onConfirm, busy, error, replacing }) {
  const [code, setCode] = useState('');

  return (
    <div className="space-y-3 rounded-md border border-border p-4">
      {replacing && (
        <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          Your current authenticator keeps working until you confirm this new one.
        </p>
      )}
      <p className="text-sm text-foreground">
        Scan this QR code with your authenticator app, then enter the 6-digit code it shows.
      </p>
      {enroll?.qrDataUrl && (
        <img src={enroll.qrDataUrl} alt="Authenticator app QR code" className="h-40 w-40" />
      )}
      {enroll?.secret && (
        <p className="text-xs text-muted-foreground">
          Or enter this secret manually: <span className="font-mono">{enroll.secret}</span>
        </p>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onConfirm(code.trim());
        }}
        className="flex gap-2"
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
          autoFocus
          className="h-9 w-32 rounded-md border border-input bg-background px-3 text-sm"
        />
        <Button type="submit" disabled={busy || !code.trim()}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Verify & enable'}
        </Button>
      </form>
    </div>
  );
}
