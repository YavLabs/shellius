import { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { Lock, Eye, EyeOff, Loader2, Terminal } from 'lucide-react';
import { getResetToken, resetPassword } from '@/services/userTokenService';

function validatePassword(password) {
  if (password.length < 12) return 'Password must be at least 12 characters.';
  if (!/[a-zA-Z]/.test(password)) return 'Password must contain at least one letter.';
  if (!/[0-9]/.test(password)) return 'Password must contain at least one number.';
  return null;
}

function ResetPassword() {
  const { token } = useParams();
  const navigate = useNavigate();

  const [tokenData, setTokenData] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [loadingToken, setLoadingToken] = useState(true);

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    setLoadingToken(true);
    getResetToken(token)
      .then((data) => setTokenData(data))
      .catch(() => setLoadError('Reset link is invalid or expired.'))
      .finally(() => setLoadingToken(false));
  }, [token]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');

    const validationError = validatePassword(password);
    if (validationError) {
      setError(validationError);
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }

    setSubmitting(true);
    try {
      const data = await resetPassword(token, password);
      if (data?.accessToken) localStorage.setItem('accessToken', data.accessToken);
      if (data?.refreshToken) localStorage.setItem('refreshToken', data.refreshToken);
      navigate('/', { replace: true });
    } catch (err) {
      const msg =
        err.response?.status === 400 || err.response?.status === 404
          ? 'Reset link is invalid or expired.'
          : err.response?.data?.error?.message || err.message || 'Failed to reset password.';
      setError(msg);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-lg bg-primary">
            <Terminal className="h-6 w-6 text-primary-foreground" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Shellius</h1>
          <p className="mt-1 text-sm text-muted-foreground">Reset your password</p>
        </div>

        <div className="rounded-lg border border-border bg-card p-6 shadow-sm">
          {loadingToken && (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          )}

          {!loadingToken && loadError && (
            <div className="space-y-4">
              <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {loadError}
              </div>
              <p className="text-center text-sm text-muted-foreground">
                <Link to="/login" className="text-primary underline-offset-4 hover:underline">
                  Back to sign in
                </Link>
              </p>
            </div>
          )}

          {!loadingToken && !loadError && tokenData && (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="rounded-md border border-border bg-muted/30 px-4 py-3 text-sm">
                <p className="text-muted-foreground">
                  Resetting password for{' '}
                  <span className="font-medium text-foreground">
                    {tokenData.user?.email || ''}
                  </span>
                  .
                </p>
              </div>

              {error && (
                <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {error}
                </div>
              )}

              <div>
                <label htmlFor="password" className="mb-1.5 block text-sm font-medium text-foreground">
                  New Password
                </label>
                <div className="relative">
                  <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <input
                    id="password"
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="At least 12 characters"
                    required
                    autoComplete="new-password"
                    className="h-9 w-full rounded-md border border-input bg-background pl-9 pr-9 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((p) => !p)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground"
                    tabIndex={-1}
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  Min 12 characters, must include a letter and a number.
                </p>
              </div>

              <div>
                <label htmlFor="confirm" className="mb-1.5 block text-sm font-medium text-foreground">
                  Confirm New Password
                </label>
                <div className="relative">
                  <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <input
                    id="confirm"
                    type={showConfirm ? 'text' : 'password'}
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    placeholder="Repeat your new password"
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

              <button
                type="submit"
                disabled={submitting}
                className="flex h-9 w-full items-center justify-center rounded-md bg-primary text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {submitting ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Resetting...
                  </>
                ) : (
                  'Reset password'
                )}
              </button>

              <p className="text-center text-sm text-muted-foreground">
                <Link to="/login" className="text-primary underline-offset-4 hover:underline">
                  Back to sign in
                </Link>
              </p>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}

export default ResetPassword;
