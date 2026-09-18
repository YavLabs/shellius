import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { sendMfaEmailCode } from '@/services/mfaService';

const METHOD_LABELS = {
  totp: 'Authenticator app code',
  email: 'Email code',
  backup: 'Backup code',
};

/**
 * VerifyAction — the "prove it's you" step required before disabling MFA or
 * regenerating backup codes. Lets the user pick an enrolled factor to enter
 * a code for, or fall back to their account password.
 *
 * `enrolledMethods` — subset of ['totp', 'email', 'backup'] the user has set up.
 * `hasPassword` — whether the account has a local password (SSO-only users don't).
 * `onVerify({ method, code } | { password })` — perform the actual action;
 * throw to surface an error inline.
 */
export default function VerifyAction({ enrolledMethods = [], hasPassword, onVerify, onCancel, busy, error }) {
  const codeMethods = enrolledMethods.filter((m) => METHOD_LABELS[m]);
  const [mode, setMode] = useState(codeMethods.length ? 'code' : 'password');
  const [method, setMethod] = useState(codeMethods[0] || 'totp');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [otpSent, setOtpSent] = useState(false);
  const [sendError, setSendError] = useState('');

  const handleSendCode = async () => {
    setSendError('');
    try {
      await sendMfaEmailCode();
      setOtpSent(true);
    } catch (e) {
      setSendError(e?.response?.data?.error?.message || e.message || 'Could not send code');
    }
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (mode === 'code') {
      onVerify({ method, code: code.trim() });
    } else {
      onVerify({ password });
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-3 rounded-md border border-border p-4">
      <p className="text-sm text-foreground">Verify it&apos;s you to continue.</p>

      {codeMethods.length > 0 && hasPassword && (
        <div className="flex gap-1 rounded-md border border-border p-1">
          <button
            type="button"
            onClick={() => setMode('code')}
            className={`flex-1 rounded px-2 py-1 text-xs font-medium ${mode === 'code' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'}`}
          >
            Use a code
          </button>
          <button
            type="button"
            onClick={() => setMode('password')}
            className={`flex-1 rounded px-2 py-1 text-xs font-medium ${mode === 'password' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'}`}
          >
            Use my password
          </button>
        </div>
      )}

      {error && <p className="text-xs text-destructive">{error}</p>}

      {mode === 'code' ? (
        <div className="space-y-2">
          {codeMethods.length > 1 && (
            <select
              value={method}
              onChange={(e) => { setMethod(e.target.value); setOtpSent(false); }}
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
            >
              {codeMethods.map((m) => (
                <option key={m} value={m}>{METHOD_LABELS[m]}</option>
              ))}
            </select>
          )}
          {method === 'email' && (
            <button
              type="button"
              onClick={handleSendCode}
              className="text-xs text-primary underline-offset-4 hover:underline"
            >
              {otpSent ? 'Code sent — resend' : 'Send a code to my email'}
            </button>
          )}
          {sendError && <p className="text-xs text-destructive">{sendError}</p>}
          <input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder={method === 'backup' ? 'Backup code' : '6-digit code'}
            inputMode={method === 'backup' ? 'text' : 'numeric'}
            autoComplete="one-time-code"
            autoFocus
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
          />
        </div>
      ) : (
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Current password"
          autoComplete="current-password"
          autoFocus
          className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
        />
      )}

      <div className="flex justify-end gap-2 pt-1">
        <Button type="button" variant="outline" size="sm" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button
          type="submit"
          variant="destructive"
          size="sm"
          disabled={busy || (mode === 'code' ? !code.trim() : !password)}
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Confirm'}
        </Button>
      </div>
    </form>
  );
}
