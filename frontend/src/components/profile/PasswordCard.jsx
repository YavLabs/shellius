import { useState } from 'react';
import { Lock, Eye, EyeOff, Loader2 } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import PasswordInput from '@/components/ui/PasswordInput';
import { Button } from '@/components/ui/button';
import { changeMyPassword, setMyPassword, sendSetPasswordCode } from '@/services/userService';

function validatePassword(password) {
  if (password.length < 12) return 'Password must be at least 12 characters.';
  if (!/[a-zA-Z]/.test(password)) return 'Password must contain at least one letter.';
  if (!/[0-9]/.test(password)) return 'Password must contain at least one number.';
  return null;
}

function SectionCard({ title, description, children }) {
  return (
    <div className="rounded-lg border border-border bg-card p-6">
      <div className="mb-5">
        <h2 className="text-base font-semibold text-foreground">{title}</h2>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>
      {children}
    </div>
  );
}

const INPUT =
  'h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring';

const METHOD_LABELS = { totp: 'Authenticator code', email: 'Email code', backup: 'Backup code' };

/**
 * SetPasswordForm — accounts without a password (SSO-only) add one. The
 * backend needs a recent-auth proof: a code from an enrolled MFA factor, or
 * (no MFA) a one-time code emailed to the account.
 */
function SetPasswordForm() {
  const { user, refreshUser } = useAuth();
  const mfa = user?.mfa || {};
  const enrolled = !!(mfa.totpEnabled || mfa.emailEnabled || mfa.backupCodesRemaining > 0);
  const methods = enrolled
    ? [mfa.totpEnabled && 'totp', mfa.emailEnabled && 'email', mfa.backupCodesRemaining > 0 && 'backup'].filter(Boolean)
    : ['email'];

  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [method, setMethod] = useState(methods[0]);
  const [code, setCode] = useState('');
  const [codeSent, setCodeSent] = useState('');
  const [sending, setSending] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const strengthError = newPassword ? validatePassword(newPassword) : null;

  const sendCode = async () => {
    setError('');
    setSending(true);
    try {
      const r = await sendSetPasswordCode();
      setCodeSent(r?.emailHint || 'your email');
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message || 'Could not send the code.');
    } finally {
      setSending(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    const validationError = validatePassword(newPassword);
    if (validationError) return setError(validationError);
    if (newPassword !== confirmPassword) return setError('Passwords do not match.');
    if (!code.trim()) return setError('Enter the verification code.');
    setSaving(true);
    try {
      await setMyPassword({ newPassword, method, code: code.trim() });
      setSuccess('Password added. You can now sign in with your email and password too.');
      setNewPassword('');
      setConfirmPassword('');
      setCode('');
      await refreshUser?.();
    } catch (err) {
      const c = err.response?.data?.error?.code;
      setError(
        c === 'MFA_INVALID'
          ? 'Invalid verification code.'
          : err.response?.data?.error?.message || err.message || 'Failed to set the password.'
      );
    } finally {
      setSaving(false);
    }
  };

  if (success) {
    return (
      <div className="rounded-md border border-green-500/30 bg-green-500/10 px-3 py-2 text-sm text-green-700 dark:text-green-400">
        {success}
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <p className="text-sm text-muted-foreground">
        You sign in with single sign-on. Add a password to also sign in with your email — useful if your identity
        provider is unavailable.
      </p>
      {error && (
        <div role="alert" className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}
      <div>
        <label htmlFor="set-password" className="mb-1.5 block text-sm font-medium text-foreground">
          New password <span className="text-destructive">*</span>
        </label>
        <PasswordInput
          id="set-password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          placeholder="At least 12 characters"
          autoComplete="new-password"
          required
          className={INPUT}
        />
        <p className={`mt-1 text-xs ${strengthError ? 'text-amber-600 dark:text-amber-400' : newPassword ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'}`}>
          {newPassword ? strengthError || 'Looks good.' : 'Min 12 characters, must include a letter and a number.'}
        </p>
      </div>
      <div>
        <label htmlFor="set-password-confirm" className="mb-1.5 block text-sm font-medium text-foreground">
          Confirm password <span className="text-destructive">*</span>
        </label>
        <PasswordInput
          id="set-password-confirm"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          placeholder="Repeat the password"
          autoComplete="new-password"
          required
          className={INPUT}
        />
      </div>

      <div className="space-y-2 rounded-md border border-border p-3">
        <p className="text-xs text-muted-foreground">
          {enrolled
            ? 'Confirm it’s you with your two-factor authentication.'
            : 'Confirm it’s you with a code we email to your account.'}
        </p>
        {methods.length > 1 && (
          <div className="flex gap-1 rounded-md border border-border p-1" role="tablist" aria-label="Verification method">
            {methods.map((m) => (
              <button
                key={m}
                type="button"
                role="tab"
                aria-selected={method === m}
                onClick={() => {
                  setMethod(m);
                  setCode('');
                }}
                className={`flex-1 rounded px-2 py-1 text-xs font-medium ${method === m ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'}`}
              >
                {METHOD_LABELS[m]}
              </button>
            ))}
          </div>
        )}
        {method === 'email' && (
          <button
            type="button"
            onClick={sendCode}
            disabled={sending}
            className="text-xs text-primary underline-offset-4 hover:underline disabled:text-muted-foreground"
          >
            {codeSent ? `Code sent to ${codeSent} — resend` : 'Email me a code'}
          </button>
        )}
        <input
          aria-label={METHOD_LABELS[method]}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          autoComplete="one-time-code"
          inputMode={method === 'backup' ? 'text' : 'numeric'}
          maxLength={method === 'backup' ? 14 : 6}
          placeholder={method === 'backup' ? 'xxxx-xxxx-xxxx' : '6-digit code'}
          className={`${INPUT} tracking-widest`}
        />
      </div>

      <Button type="submit" size="sm" disabled={saving}>
        {saving ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
        Set password
      </Button>
    </form>
  );
}

/**
 * PasswordCard — change-password form. Changing your password rotates your
 * tokens and revokes every other refresh-token family, so we store the new
 * pair via AuthContext instead of leaving the user's own session stale.
 */
export default function PasswordCard({ isPasswordUser }) {
  const { applyTokenPair, user } = useAuth();
  const blockedBySso = !!user?.passwordBlockedBySso;

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState('');
  const [error, setError] = useState('');

  const strengthError = newPassword ? validatePassword(newPassword) : null;

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setSuccess('');

    const validationError = validatePassword(newPassword);
    if (validationError) {
      setError(validationError);
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setSaving(true);
    try {
      const result = await changeMyPassword({ currentPassword, newPassword });
      if (result?.accessToken) {
        applyTokenPair(result);
      }
      setSuccess('Password updated. Other sessions were signed out.');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message || 'Failed to update password.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <SectionCard
      title={isPasswordUser || blockedBySso ? 'Password' : 'Set a password'}
      description={isPasswordUser ? 'Update your account password.' : undefined}
    >
      {!isPasswordUser && blockedBySso ? (
        <p className="text-sm text-muted-foreground">
          Your organization signs in with single sign-on, so passwords aren&apos;t used.
        </p>
      ) : !isPasswordUser ? (
        <SetPasswordForm />
      ) : (
        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <div role="alert" className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}
          {success && (
            <div className="rounded-md border border-green-500/30 bg-green-500/10 px-3 py-2 text-sm text-green-700 dark:text-green-400">
              {success}
            </div>
          )}

          <div>
            <label htmlFor="current-password" className="mb-1.5 block text-sm font-medium text-foreground">
              Current password <span className="text-destructive">*</span>
            </label>
            <div className="relative">
              <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                id="current-password"
                type={showCurrent ? 'text' : 'password'}
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                placeholder="Enter current password"
                required
                autoComplete="current-password"
                className="h-9 w-full rounded-md border border-input bg-background pl-9 pr-9 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              />
              <button
                type="button"
                onClick={() => setShowCurrent((p) => !p)}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground"
                tabIndex={-1}
              >
                {showCurrent ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>

          <div>
            <label htmlFor="new-password" className="mb-1.5 block text-sm font-medium text-foreground">
              New password <span className="text-destructive">*</span>
            </label>
            <div className="relative">
              <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                id="new-password"
                type={showNew ? 'text' : 'password'}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="At least 12 characters"
                required
                autoComplete="new-password"
                aria-describedby="new-password-hint"
                className="h-9 w-full rounded-md border border-input bg-background pl-9 pr-9 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              />
              <button
                type="button"
                onClick={() => setShowNew((p) => !p)}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground"
                tabIndex={-1}
              >
                {showNew ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            <p
              id="new-password-hint"
              className={`mt-1 text-xs ${strengthError ? 'text-amber-600 dark:text-amber-400' : newPassword ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'}`}
            >
              {newPassword ? (strengthError || 'Looks good.') : 'Min 12 characters, must include a letter and a number.'}
            </p>
          </div>

          <div>
            <label htmlFor="confirm-password" className="mb-1.5 block text-sm font-medium text-foreground">
              Confirm new password <span className="text-destructive">*</span>
            </label>
            <div className="relative">
              <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                id="confirm-password"
                type={showConfirm ? 'text' : 'password'}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Repeat new password"
                required
                autoComplete="new-password"
                className="h-9 w-full rounded-md border border-input bg-background pl-9 pr-9 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              />
              <button
                type="button"
                onClick={() => setShowConfirm((p) => !p)}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground"
                tabIndex={-1}
              >
                {showConfirm ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>

          <div>
            <button
              type="submit"
              disabled={saving}
              className="flex h-9 items-center gap-1.5 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              Update password
            </button>
          </div>
        </form>
      )}
    </SectionCard>
  );
}
