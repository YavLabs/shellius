import { useState, useEffect } from 'react';
import { useNavigate, Link, useSearchParams } from 'react-router-dom';
import { Mail, Lock, Eye, EyeOff, KeyRound, Loader2 } from 'lucide-react';
import { BrandMark } from '@/components/common/BrandLogo';
import { useAuth } from '@/context/AuthContext';
import { getRegistrationStatus } from '@/services/registrationService';
import api from '@/services/api';

// Inline multi-color Google "G" mark — avoids pulling in an icon pack
// just for the brand logo and stays crisp at any size.
function GoogleGlyph({ className = '' }) {
  return (
    <svg viewBox="0 0 48 48" className={className} aria-hidden="true">
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
      <path fill="none" d="M0 0h48v48H0z" />
    </svg>
  );
}

function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [registrationEnabled, setRegistrationEnabled] = useState(false);
  const [ssoStatus, setSsoStatus] = useState({ enabled: false, presetId: null, orgSlug: null });
  const [ssoSubmitting, setSsoSubmitting] = useState(false);
  const { login, loginWithTokens } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const isDeleted = searchParams.get('deleted') === '1';

  // Honor ?redirect=<path> after successful login. This is how the device-auth
  // page (and any other page that gates on auth) preserves its destination
  // across the login flow — without this, users who hit /device?user_code=XXX
  // while logged out get bounced to /dashboard after login and have to
  // manually navigate back, breaking the TUI device-login UX.
  // Only same-origin relative paths are accepted to prevent open-redirect.
  const safePostLoginDest = (() => {
    const r = searchParams.get('redirect');
    if (!r) return '/';
    if (!r.startsWith('/') || r.startsWith('//')) return '/';
    return r;
  })();

  useEffect(() => {
    getRegistrationStatus()
      .then((enabled) => setRegistrationEnabled(enabled))
      .catch(() => setRegistrationEnabled(false));
    api
      .get('/auth/sso/public-status')
      .then((r) => setSsoStatus(r.data?.data || { enabled: false }))
      .catch(() => setSsoStatus({ enabled: false }));
  }, []);

  // Listen for the SSO popup completion message
  useEffect(() => {
    function onMessage(e) {
      if (e.origin !== window.location.origin) return;
      const msg = e.data || {};
      if (msg.type !== 'shellius:sso') return;
      setSsoSubmitting(false);
      if (msg.ok && msg.accessToken && msg.refreshToken) {
        loginWithTokens({ accessToken: msg.accessToken, refreshToken: msg.refreshToken })
          .then(() => navigate(safePostLoginDest, { replace: true }))
          .catch((err) => setError(err?.message || 'SSO login failed'));
      } else if (msg.error) {
        setError(`SSO failed: ${msg.error}`);
      }
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [loginWithTokens, navigate, safePostLoginDest]);

  const handleSsoLogin = () => {
    if (!ssoStatus.enabled || !ssoStatus.orgSlug) return;
    setError('');
    setSsoSubmitting(true);
    const url = `/api/auth/sso/${ssoStatus.orgSlug}`;
    const w = 480;
    const h = 640;
    const left = window.screenX + (window.outerWidth - w) / 2;
    const top = window.screenY + (window.outerHeight - h) / 2;
    const popup = window.open(
      url,
      'shellius-sso',
      `width=${w},height=${h},left=${left},top=${top},menubar=no,toolbar=no,location=no,status=no`
    );
    if (!popup) {
      setSsoSubmitting(false);
      setError('Popup was blocked. Please allow popups for this site and try again.');
      return;
    }
    // Watchdog: if user closes the popup without completing, reset
    const watcher = setInterval(() => {
      if (popup.closed) {
        clearInterval(watcher);
        setSsoSubmitting((s) => {
          if (s) setError('SSO sign-in cancelled.');
          return false;
        });
      }
    }, 600);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      await login(email, password);
      navigate(safePostLoginDest, { replace: true });
    } catch (err) {
      setError(err.message || 'Login failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm">
        {isDeleted && (
          <div className="mb-4 rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-400">
            Your account has been deleted. If this was a mistake, contact your administrator within
            30 days.
          </div>
        )}

        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex justify-center">
            <BrandMark size="lg" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            {import.meta.env.VITE_BRAND_NAME || 'Shellius'}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">Sign in to your account</p>
        </div>

        <div className="rounded-lg border border-border bg-card p-6 shadow-sm">
          <form onSubmit={handleSubmit} className="space-y-4">
            {error && (
              <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </div>
            )}

            <div>
              <label htmlFor="email" className="mb-1.5 block text-sm font-medium text-foreground">
                Email
              </label>
              <div className="relative">
                <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <input
                  id="email"
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
              <div className="mb-1.5 flex items-center justify-between">
                <label htmlFor="password" className="text-sm font-medium text-foreground">
                  Password
                </label>
                <Link
                  to="/forgot-password"
                  className="text-xs text-muted-foreground hover:text-foreground underline-offset-4 hover:underline"
                >
                  Forgot password?
                </Link>
              </div>
              <div className="relative">
                <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <input
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter your password"
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
            </div>

            <button
              type="submit"
              disabled={submitting}
              className="flex h-9 w-full items-center justify-center rounded-md bg-primary text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submitting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Signing in...
                </>
              ) : (
                'Sign in'
              )}
            </button>

            {ssoStatus.enabled && (
              <>
                <div className="relative my-2">
                  <div className="absolute inset-0 flex items-center">
                    <div className="w-full border-t border-border" />
                  </div>
                  <div className="relative flex justify-center text-xs">
                    <span className="bg-card px-2 uppercase tracking-wider text-muted-foreground">
                      or
                    </span>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={handleSsoLogin}
                  disabled={ssoSubmitting}
                  className="flex h-9 w-full items-center justify-center rounded-md border border-input bg-background text-sm font-medium text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {ssoSubmitting ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Opening sign-in window…
                    </>
                  ) : ssoStatus.presetId === 'google' ? (
                    <>
                      <GoogleGlyph className="mr-2 h-4 w-4" />
                      Sign in with Google
                    </>
                  ) : ssoStatus.presetId === 'entra' ? (
                    <>
                      <KeyRound className="mr-2 h-4 w-4" />
                      Sign in with Microsoft
                    </>
                  ) : ssoStatus.presetId === 'okta' ? (
                    <>
                      <KeyRound className="mr-2 h-4 w-4" />
                      Sign in with Okta
                    </>
                  ) : ssoStatus.presetId === 'auth0' ? (
                    <>
                      <KeyRound className="mr-2 h-4 w-4" />
                      Sign in with Auth0
                    </>
                  ) : (
                    <>
                      <KeyRound className="mr-2 h-4 w-4" />
                      Sign in with SSO
                    </>
                  )}
                </button>
              </>
            )}

            {registrationEnabled && (
              <p className="text-center text-sm text-muted-foreground">
                Don&apos;t have an account?{' '}
                <Link to="/register" className="text-primary underline-offset-4 hover:underline">
                  Sign up
                </Link>
              </p>
            )}
          </form>
        </div>
      </div>
    </div>
  );
}

export default Login;
