import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Mail, User, Lock, Eye, EyeOff, Loader2, Terminal } from 'lucide-react';
import { getRegistrationStatus, register } from '@/services/registrationService';

function validatePassword(password) {
  if (password.length < 12) return 'Password must be at least 12 characters.';
  if (!/[a-zA-Z]/.test(password)) return 'Password must contain at least one letter.';
  if (!/[0-9]/.test(password)) return 'Password must contain at least one number.';
  return null;
}

function Register() {
  const [registrationEnabled, setRegistrationEnabled] = useState(null);
  const [statusLoading, setStatusLoading] = useState(true);

  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    setStatusLoading(true);
    getRegistrationStatus()
      .then((enabled) => setRegistrationEnabled(enabled))
      .catch(() => setRegistrationEnabled(false))
      .finally(() => setStatusLoading(false));
  }, []);

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
    if (!termsAccepted) {
      setError('You must accept the Terms of Service and Privacy Policy to continue.');
      return;
    }

    setSubmitting(true);
    try {
      await register({ email, name, password });
      setSuccess(true);
    } catch (err) {
      setError(
        err.response?.data?.error?.message || err.message || 'Registration failed. Please try again.'
      );
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
          <p className="mt-1 text-sm text-muted-foreground">Create your account</p>
        </div>

        <div className="rounded-lg border border-border bg-card p-6 shadow-sm">
          {statusLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : !registrationEnabled ? (
            <div className="space-y-4">
              <div className="rounded-md border border-border bg-muted/30 px-4 py-4 text-sm text-muted-foreground">
                Self-service registration is not available for this organization. Ask your
                administrator to invite you.
              </div>
              <p className="text-center text-sm text-muted-foreground">
                Already have an account?{' '}
                <Link to="/login" className="text-primary underline-offset-4 hover:underline">
                  Sign in
                </Link>
              </p>
            </div>
          ) : success ? (
            <div className="space-y-4">
              <div className="rounded-md border border-green-500/30 bg-green-500/10 px-4 py-4 text-sm text-green-700 dark:text-green-400">
                Check your email — we've sent you a verification link.
              </div>
              <Link
                to="/login"
                className="flex h-9 w-full items-center justify-center rounded-md border border-input bg-background text-sm font-medium text-foreground transition-colors hover:bg-accent"
              >
                Back to login
              </Link>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              {error && (
                <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {error}
                </div>
              )}

              <div>
                <label htmlFor="reg-email" className="mb-1.5 block text-sm font-medium text-foreground">
                  Email
                </label>
                <div className="relative">
                  <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <input
                    id="reg-email"
                    type="email"
                    autoComplete="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@company.com"
                    required
                    className="h-9 w-full rounded-md border border-input bg-background pl-9 pr-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                </div>
              </div>

              <div>
                <label htmlFor="reg-name" className="mb-1.5 block text-sm font-medium text-foreground">
                  Full name
                </label>
                <div className="relative">
                  <User className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <input
                    id="reg-name"
                    type="text"
                    autoComplete="name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Your name"
                    required
                    className="h-9 w-full rounded-md border border-input bg-background pl-9 pr-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                </div>
              </div>

              <div>
                <label htmlFor="reg-password" className="mb-1.5 block text-sm font-medium text-foreground">
                  Password
                </label>
                <div className="relative">
                  <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <input
                    id="reg-password"
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="new-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="At least 12 characters"
                    required
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
                <label htmlFor="reg-confirm" className="mb-1.5 block text-sm font-medium text-foreground">
                  Confirm password
                </label>
                <div className="relative">
                  <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <input
                    id="reg-confirm"
                    type={showConfirm ? 'text' : 'password'}
                    autoComplete="new-password"
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    placeholder="Repeat your password"
                    required
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

              <div className="flex items-start gap-2 pt-1">
                <input
                  id="reg-terms"
                  type="checkbox"
                  checked={termsAccepted}
                  onChange={(e) => setTermsAccepted(e.target.checked)}
                  className="mt-0.5 h-4 w-4 shrink-0 rounded border-input accent-primary"
                />
                <label htmlFor="reg-terms" className="text-sm text-muted-foreground leading-snug">
                  I agree to the{' '}
                  <a href="#" className="text-primary underline-offset-4 hover:underline">
                    Terms of Service
                  </a>{' '}
                  and{' '}
                  <a href="#" className="text-primary underline-offset-4 hover:underline">
                    Privacy Policy
                  </a>
                </label>
              </div>

              <button
                type="submit"
                disabled={submitting}
                className="flex h-9 w-full items-center justify-center rounded-md bg-primary text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {submitting ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Creating account...
                  </>
                ) : (
                  'Create account'
                )}
              </button>

              <p className="text-center text-sm text-muted-foreground">
                Already have an account?{' '}
                <Link to="/login" className="text-primary underline-offset-4 hover:underline">
                  Sign in
                </Link>
              </p>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}

export default Register;
