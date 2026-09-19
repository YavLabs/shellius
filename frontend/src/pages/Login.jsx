import { useState, useEffect, useRef } from 'react';
import { useNavigate, Link, useSearchParams } from 'react-router-dom';
import { Mail, Lock, Eye, EyeOff, Loader2, ShieldAlert, LogOut } from 'lucide-react';
import { BrandMark } from '@/components/common/BrandLogo';
import MfaChallenge from '@/components/auth/MfaChallenge';
import ProviderIcon from '@/components/settings/sso/ProviderIcon';
import { useAuth } from '@/context/AuthContext';
import { getRegistrationStatus } from '@/services/registrationService';
import api from '@/services/api';
import AuthShell from '@/components/auth/AuthShell';

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

// Live "Try again in Nm Ss" countdown driven by details.retryAfterSeconds
// from a 423 ACCOUNT_LOCKED response.
function useCountdown(initialSeconds) {
  const [remaining, setRemaining] = useState(initialSeconds || 0);
  const startedAt = useRef(Date.now());

  useEffect(() => {
    if (!initialSeconds) {
      setRemaining(0);
      return undefined;
    }
    startedAt.current = Date.now();
    setRemaining(initialSeconds);
    const t = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startedAt.current) / 1000);
      setRemaining(Math.max(0, initialSeconds - elapsed));
    }, 1000);
    return () => clearInterval(t);
  }, [initialSeconds]);

  return remaining;
}

function formatRetry(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m <= 0) return `${s}s`;
  return `${m}m ${s}s`;
}

// Friendly fallback label for the legacy single-provider shape
// (`{ enabled, presetId }` with no `providers` array).
function ssoLoginLabel(presetId) {
  const names = { google: 'Google', entra: 'Microsoft', okta: 'Okta', auth0: 'Auth0', github: 'GitHub' };
  return names[presetId] || 'SSO';
}

/** One "Continue with {name}" button per active SSO provider. */
function SsoProviderButtons({ providers, submitting, onSelect }) {
  return (
    <div className="space-y-2">
      {providers.map((provider) => (
        <button
          key={provider.id ?? provider.presetId}
          type="button"
          onClick={() => onSelect(provider.id)}
          disabled={submitting}
          className="flex h-9 w-full items-center justify-center rounded-md border border-input bg-background text-sm font-medium text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : provider.presetId === 'google' ? (
            <GoogleGlyph className="mr-2 h-4 w-4" />
          ) : (
            <ProviderIcon presetId={provider.presetId} className="mr-2 h-4 w-4" />
          )}
          {submitting ? 'Opening sign-in window…' : `Continue with ${provider.name || ssoLoginLabel(provider.presetId)}`}
        </button>
      ))}
    </div>
  );
}

function Login() {
  const [step, setStep] = useState('email'); // 'email' | 'password' | 'mfa' | 'sent' | 'sso'
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [lockout, setLockout] = useState(null); // { retryAfterSeconds }
  const [submitting, setSubmitting] = useState(false);
  const [continuing, setContinuing] = useState(false);
  const [registrationEnabled, setRegistrationEnabled] = useState(false);
  const [ssoStatus, setSsoStatus] = useState({ enabled: false, presetId: null, orgSlug: null, providers: [] });
  const [ssoSubmitting, setSsoSubmitting] = useState(false);
  const { login, loginWithTokens, applyAuthResult } = useAuth();
  const [mfaChallenge, setMfaChallenge] = useState(null); // { mfaToken, methods, emailHint }
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const isDeleted = searchParams.get('deleted') === '1';
  const sessionRevoked = searchParams.get('reason') === 'session_revoked';

  const retryRemaining = useCountdown(lockout?.retryAfterSeconds);

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
      .then((r) => {
        const data = r.data?.data || {};
        setSsoStatus({
          enabled: !!data.enabled,
          presetId: data.presetId || null,
          orgSlug: data.orgSlug || null,
          providers: Array.isArray(data.providers) ? data.providers : [],
        });
      })
      .catch(() => setSsoStatus({ enabled: false, presetId: null, orgSlug: null, providers: [] }));
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

  // Start the OIDC/GitHub round-trip for one provider. `providerId` selects a
  // specific SsoProviderDTO (?provider=<id>); omitted, the backend falls back
  // to the org's first active provider (legacy single-provider orgs).
  const handleSsoLogin = (providerId, orgSlugOverride) => {
    const orgSlug = orgSlugOverride || ssoStatus.orgSlug;
    if (!orgSlug) return;
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
    const qs = providerId ? `?provider=${encodeURIComponent(providerId)}` : '';
    window.location.href = `/api/auth/sso/${orgSlug}${qs}`;
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
      const providers = Array.isArray(opts.providers) ? opts.providers : null;
      if (opts.hasPassword) {
        setStep('password');
      } else if (providers && providers.length > 0) {
        // No local password — show the provider button(s) prominently rather
        // than guessing which one to redirect to.
        setSsoStatus((prev) => ({
          ...prev,
          enabled: true,
          providers,
          orgSlug: opts.orgSlug || prev.orgSlug,
        }));
        if (providers.length === 1) {
          handleSsoLogin(providers[0].id, opts.orgSlug);
        } else {
          setStep('sso');
        }
      } else if (opts.ssoEnabled) {
        // Legacy single-provider backend with no `providers` array — go
        // straight to the identity provider.
        handleSsoLogin(undefined, opts.orgSlug);
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
    setLockout(null);
    setSubmitting(true);
    try {
      const result = await login(email, password);
      if (result?.mfaRequired) {
        setMfaChallenge(result);
        setStep('mfa');
        return;
      }
      navigate(safePostLoginDest, { replace: true });
    } catch (err) {
      if (err.code === 'ACCOUNT_LOCKED') {
        setLockout({ retryAfterSeconds: err.details?.retryAfterSeconds || 900 });
        setError('Too many failed attempts.');
      } else if (err.code === 'ACCOUNT_DISABLED') {
        setError('This account has been disabled. Contact your administrator.');
      } else {
        setError(err.message || 'Login failed');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleMfaSuccess = (data) => {
    applyAuthResult(data);
    navigate(safePostLoginDest, { replace: true });
  };

  const resetToEmail = () => {
    setStep('email');
    setPassword('');
    setError('');
    setLockout(null);
    setMfaChallenge(null);
  };

  const locked = !!lockout && retryRemaining > 0;

  return (
    <AuthShell>
      <div className="w-full max-w-sm">
        {isDeleted && (
          <div className="mb-4 rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-400">
            Your account has been deleted. If this was a mistake, contact your administrator within
            30 days.
          </div>
        )}

        {sessionRevoked && !isDeleted && (
          <div className="mb-4 flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-400">
            <LogOut className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              You were signed out because your session was revoked or your account changed. Please
              sign in again.
            </span>
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
          ) : step === 'sso' ? (
            <div className="space-y-4">
              <p className="text-center text-sm text-foreground">
                <span className="font-medium">{email}</span> signs in with single sign-on.
              </p>
              <SsoProviderButtons
                providers={ssoStatus.providers}
                submitting={ssoSubmitting}
                onSelect={(id) => handleSsoLogin(id)}
              />
              {error && (
                <div role="alert" className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {error}
                </div>
              )}
              <button
                type="button"
                onClick={resetToEmail}
                className="block w-full text-center text-sm text-muted-foreground hover:text-foreground"
              >
                Use a different email
              </button>
            </div>
          ) : step === 'mfa' ? (
            <MfaChallenge
              mfaToken={mfaChallenge?.mfaToken}
              methods={mfaChallenge?.methods}
              emailHint={mfaChallenge?.emailHint}
              onSuccess={handleMfaSuccess}
              onStartOver={resetToEmail}
            />
          ) : (
          <form onSubmit={step === 'password' ? handleSubmit : handleContinue} className="space-y-4">
            {error && (
              <div
                role="alert"
                aria-live="polite"
                className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              >
                <div className="flex items-start gap-2">
                  {locked && <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />}
                  <span>
                    {error}
                    {locked && (
                      <span className="block mt-0.5">
                        Try again in <span className="font-medium tabular-nums">{formatRetry(retryRemaining)}</span>.
                      </span>
                    )}
                  </span>
                </div>
              </div>
            )}

            <div>
              <label htmlFor="email" className="mb-1.5 block text-sm font-medium text-foreground">
                Email <span className="text-destructive">*</span>
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
                  Password <span className="text-destructive">*</span>
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
                disabled={submitting || locked}
                className="flex h-9 w-full items-center justify-center rounded-md bg-primary text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {submitting ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Signing in...
                  </>
                ) : locked ? (
                  `Try again in ${formatRetry(retryRemaining)}`
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

                <SsoProviderButtons
                  providers={
                    ssoStatus.providers?.length
                      ? ssoStatus.providers
                      : [{ id: null, name: ssoLoginLabel(ssoStatus.presetId), presetId: ssoStatus.presetId }]
                  }
                  submitting={ssoSubmitting}
                  onSelect={(id) => handleSsoLogin(id)}
                />
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
    </AuthShell>
  );
}

export default Login;
