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
  const [step, setStep] = useState('email'); // 'email' | 'password' | 'sent'
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [continuing, setContinuing] = useState(false);
  const [registrationEnabled, setRegistrationEnabled] = useState(false);
  const [ssoStatus, setSsoStatus] = useState({ enabled: false, presetId: null, orgSlug: null });
  const [ssoSubmitting, setSsoSubmitting] = useState(false);
  const { login, loginWithTokens, completeMfa } = useAuth();
  const [mfaChallenge, setMfaChallenge] = useState(null); // { mfaToken, methods, emailHint }
  const [mfaMethod, setMfaMethod] = useState('totp');
  const [mfaCode, setMfaCode] = useState('');
  const [otpSent, setOtpSent] = useState(false);
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

  // Listen for the SSO popup completion (postMessage + localStorage fallback)
  useEffect(() => {
    // Fallback channel: the popup writes the result to localStorage, which fires
    // a `storage` event here even when COOP severed window.opener/postMessage.
    let handled = false;
    function finish(msg) {
      if (handled) return;
      handled = true;
      setSsoSubmitting(false);
      if (msg.ok && msg.accessToken && msg.refreshToken) {
        loginWithTokens({ accessToken: msg.accessToken, refreshToken: msg.refreshToken })
          .then(() => navigate(safePostLoginDest, { replace: true }))
          .catch((err) => setError(err?.message || 'SSO login failed'));
      } else if (msg.error) {
        setError(`SSO failed: ${msg.error}`);
      }
    }
    function onMessageWrap(e) {
      if (e.origin !== window.location.origin) return;
      const msg = e.data || {};
      if (msg.type !== 'shellius:sso') return;
      finish(msg);
    }
    function onStorage(e) {
      if (e.key !== 'shellius_sso_msg' || !e.newValue) return;
      try {
        const msg = JSON.parse(e.newValue);
        if (msg.type === 'shellius:sso') {
          localStorage.removeItem('shellius_sso_msg');
          finish(msg);
        }
      } catch {
        /* ignore */
      }
    }
    window.addEventListener('message', onMessageWrap);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener('message', onMessageWrap);
      window.removeEventListener('storage', onStorage);
    };
  }, [loginWithTokens, navigate, safePostLoginDest]);

  const handleSsoLogin = () => {
    if (!ssoStatus.enabled || !ssoStatus.orgSlug) return;
    setError('');
    setSsoSubmitting(true);
    // Full-page redirect (no popup). Popups are unreliable across the
    // cross-origin IdP round-trip — privacy browsers (e.g. Brave) clear
    // window.name and COOP severs window.opener, so the handoff fails and the
    // app loads inside the popup. A same-tab redirect is the robust OAuth flow.
    // Preserve the post-login destination for AuthCallback to honor.
    try {
      sessionStorage.setItem('sso_redirect', safePostLoginDest);
    } catch {
      /* ignore */
    }
    window.location.href = `/api/auth/sso/${ssoStatus.orgSlug}`;
  };

  // Email-first: decide whether to show a password field, start SSO, or send a
  // set-password link, based on the account's auth state.
  const handleContinue = async (e) => {
    e.preventDefault();
    setError('');
    setContinuing(true);
    try {
      const r = await api.post('/auth/login-options', { email });
      const opts = r.data?.data || {};
      if (opts.hasPassword) {
        setStep('password');
      } else if (opts.ssoEnabled) {
        // No local password — sign in via the identity provider.
        handleSsoLogin();
      } else {
        // No password and no SSO — email a secure set-password link rather than
        // letting anyone set a password just by knowing the address.
        await api.post('/auth/password-reset', { email }).catch(() => {});
        setStep('sent');
      }
    } catch (err) {
      setError(err?.response?.data?.error?.message || err.message || 'Something went wrong');
    } finally {
      setContinuing(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      const result = await login(email, password);
      if (result?.mfaRequired) {
        setMfaChallenge(result);
        setMfaMethod(result.methods?.includes('totp') ? 'totp' : result.methods?.[0] || 'totp');
        setStep('mfa');
        return;
      }
      navigate(safePostLoginDest, { replace: true });
    } catch (err) {
      setError(err.message || 'Login failed');
    } finally {
      setSubmitting(false);
    }
  };

  const handleMfaVerify = async (e) => {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      await completeMfa(mfaChallenge.mfaToken, mfaMethod, mfaCode.trim());
      navigate(safePostLoginDest, { replace: true });
    } catch (err) {
      setError(err?.response?.data?.error?.message || err.message || 'Verification failed');
    } finally {
      setSubmitting(false);
    }
  };

  const sendOtp = async () => {
    setError('');
    try {
      await import('@/services/mfaService').then((m) => m.sendMfaOtp(mfaChallenge.mfaToken));
      setOtpSent(true);
    } catch (err) {
      setError(err?.response?.data?.error?.message || err.message || 'Could not send code');
    }
  };

  const resetToEmail = () => {
    setStep('email');
    setPassword('');
    setError('');
    setMfaChallenge(null);
    setMfaCode('');
    setOtpSent(false);
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
          {step === 'sent' ? (
            <div className="space-y-4 text-center">
              <Mail className="mx-auto h-10 w-10 text-emerald-500" />
              <p className="text-sm text-foreground">
                If <span className="font-medium">{email}</span> has an account, we&apos;ve sent a
                link to set your password. Check your inbox to continue.
              </p>
              <button
                type="button"
                onClick={resetToEmail}
                className="text-sm text-primary underline-offset-4 hover:underline"
              >
                Use a different email
              </button>
            </div>
          ) : step === 'mfa' ? (
            <form onSubmit={handleMfaVerify} className="space-y-4">
              {error && (
                <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {error}
                </div>
              )}
              <p className="text-sm text-muted-foreground">
                Two-factor authentication is required. Enter a verification code to continue.
              </p>

              {mfaChallenge?.methods?.length > 1 && (
                <div className="flex gap-1 rounded-md border border-border p-1">
                  {mfaChallenge.methods.includes('totp') && (
                    <button
                      type="button"
                      onClick={() => setMfaMethod('totp')}
                      className={`flex-1 rounded px-2 py-1 text-xs font-medium ${mfaMethod === 'totp' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'}`}
                    >
                      Authenticator
                    </button>
                  )}
                  {mfaChallenge.methods.includes('email') && (
                    <button
                      type="button"
                      onClick={() => setMfaMethod('email')}
                      className={`flex-1 rounded px-2 py-1 text-xs font-medium ${mfaMethod === 'email' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'}`}
                    >
                      Email code
                    </button>
                  )}
                </div>
              )}

              {mfaMethod === 'email' && (
                <button
                  type="button"
                  onClick={sendOtp}
                  className="text-xs text-primary underline-offset-4 hover:underline"
                >
                  {otpSent ? `Code sent to ${mfaChallenge?.emailHint || 'your email'} — resend` : `Send a code to ${mfaChallenge?.emailHint || 'your email'}`}
                </button>
              )}

              <div>
                <label className="mb-1.5 block text-sm font-medium text-foreground">
                  {mfaMethod === 'backup' ? 'Backup code' : 'Verification code'}
                </label>
                <input
                  value={mfaCode}
                  onChange={(e) => setMfaCode(e.target.value)}
                  placeholder={mfaMethod === 'totp' ? '6-digit code' : 'Enter code'}
                  autoFocus
                  inputMode="numeric"
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm tracking-widest text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>

              <button
                type="submit"
                disabled={submitting || !mfaCode.trim()}
                className="flex h-9 w-full items-center justify-center rounded-md bg-primary text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {submitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Verify
              </button>

              <div className="flex items-center justify-between text-xs">
                <button type="button" onClick={() => setMfaMethod('backup')} className="text-muted-foreground hover:text-foreground">
                  Use a backup code
                </button>
                <button type="button" onClick={resetToEmail} className="text-muted-foreground hover:text-foreground">
                  Cancel
                </button>
              </div>
            </form>
          ) : (
          <form onSubmit={step === 'password' ? handleSubmit : handleContinue} className="space-y-4">
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
                  readOnly={step === 'password'}
                  className={`h-9 w-full rounded-md border border-input pl-9 pr-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring ${step === 'password' ? 'bg-muted/40 cursor-default' : 'bg-background'}`}
                />
                {step === 'password' && (
                  <button
                    type="button"
                    onClick={resetToEmail}
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded px-1.5 text-xs text-muted-foreground hover:text-foreground"
                    tabIndex={-1}
                  >
                    Change
                  </button>
                )}
              </div>
            </div>

            {step === 'password' && (
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
                  autoFocus
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
            )}

            {step === 'password' ? (
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
            ) : (
              <button
                type="submit"
                disabled={continuing || ssoSubmitting}
                className="flex h-9 w-full items-center justify-center rounded-md bg-primary text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {continuing ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Continuing...
                  </>
                ) : (
                  'Continue'
                )}
              </button>
            )}

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
          )}
        </div>
      </div>
    </div>
  );
}

export default Login;
