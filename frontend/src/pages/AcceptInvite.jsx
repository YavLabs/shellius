import { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { Lock, Eye, EyeOff, Loader2, User } from 'lucide-react';
import { BrandMark } from '@/components/common/BrandLogo';
import { getInvite, acceptInvite } from '@/services/userTokenService';

function validatePassword(password) {
  if (password.length < 12) return 'Password must be at least 12 characters.';
  if (!/[a-zA-Z]/.test(password)) return 'Password must contain at least one letter.';
  if (!/[0-9]/.test(password)) return 'Password must contain at least one number.';
  return null;
}

function AcceptInvite() {
  const { token } = useParams();
  const navigate = useNavigate();

  const [inviteData, setInviteData] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [loadingInvite, setLoadingInvite] = useState(true);

  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    setLoadingInvite(true);
    getInvite(token)
      .then((data) => {
        setInviteData(data);
        if (data?.user?.name) setName(data.user.name);
      })
      .catch(() => setLoadError('Invite link is invalid or expired.'))
      .finally(() => setLoadingInvite(false));
  }, [token]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');

    if (!name.trim()) {
      setError('Please enter your name.');
      return;
    }
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
      const data = await acceptInvite(token, password, name.trim());
      if (data?.accessToken) localStorage.setItem('accessToken', data.accessToken);
      if (data?.refreshToken) localStorage.setItem('refreshToken', data.refreshToken);
      navigate('/', { replace: true });
    } catch (err) {
      const msg =
        err.response?.status === 400 || err.response?.status === 404
          ? 'Invite link is invalid or expired.'
          : err.response?.data?.error?.message || err.message || 'Failed to set up account.';
      setError(msg);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex justify-center">
            <BrandMark size="lg" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            {import.meta.env.VITE_BRAND_NAME || 'Shellius'}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">Set up your account</p>
        </div>

        <div className="rounded-lg border border-border bg-card p-6 shadow-sm">
          {loadingInvite && (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          )}

          {!loadingInvite && loadError && (
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

          {!loadingInvite && !loadError && inviteData && (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="rounded-md border border-border bg-muted/30 px-4 py-3 text-sm">
                <p className="text-muted-foreground">
                  You have been invited to{' '}
                  <span className="font-medium text-foreground">
                    {inviteData.org?.name || 'Shellius'}
                  </span>
                  .
                </p>
              </div>

              {/* Email — read-only */}
              <div>
                <label htmlFor="invite-email" className="mb-1.5 block text-sm font-medium text-foreground">
                  Email
                </label>
                <input
                  id="invite-email"
                  type="email"
                  value={inviteData.user?.email || ''}
                  readOnly
                  className="h-9 w-full rounded-md border border-input bg-muted/40 px-3 text-sm text-muted-foreground cursor-default focus:outline-none"
                />
              </div>

              {/* Name — editable, pre-filled from invite if present */}
              <div>
                <label htmlFor="invite-name" className="mb-1.5 block text-sm font-medium text-foreground">
                  Full name
                </label>
                <div className="relative">
                  <User className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <input
                    id="invite-name"
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

              {error && (
                <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {error}
                </div>
              )}

              <div>
                <label htmlFor="invite-password" className="mb-1.5 block text-sm font-medium text-foreground">
                  Set password
                </label>
                <div className="relative">
                  <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <input
                    id="invite-password"
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
                <label htmlFor="invite-confirm" className="mb-1.5 block text-sm font-medium text-foreground">
                  Confirm password
                </label>
                <div className="relative">
                  <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <input
                    id="invite-confirm"
                    type={showConfirm ? 'text' : 'password'}
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    placeholder="Repeat your password"
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

              <div className="flex items-start gap-2 pt-1">
                <input
                  id="invite-terms"
                  type="checkbox"
                  checked={termsAccepted}
                  onChange={(e) => setTermsAccepted(e.target.checked)}
                  className="mt-0.5 h-4 w-4 shrink-0 rounded border-input accent-primary"
                />
                <label htmlFor="invite-terms" className="text-sm text-muted-foreground leading-snug">
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
                    Setting up account...
                  </>
                ) : (
                  'Set up my account'
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

export default AcceptInvite;
