import { useState, useEffect, useRef } from 'react';
import { useNavigate, Link, useSearchParams } from 'react-router-dom';
import { Mail, Eye, EyeOff, Loader2, ShieldAlert, LogOut } from 'lucide-react';
import MfaChallenge from '@/components/auth/MfaChallenge';
import ProviderGlyph from '@/components/auth/ProviderGlyph';
import { useAuth } from '@/context/AuthContext';
import { getRegistrationStatus } from '@/services/registrationService';
import api from '@/services/api';
import AuthShell from '@/components/auth/AuthShell';
import PillField from '@/components/auth/PillField';

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

/**
 * Fey-style sign-in buttons under an "or continue with" divider: one
 * full-width "Sign in with X" button per provider, stacked.
 */
function SsoTextButtons({ providers, submitting, onSelect, showDivider = true, verb = 'Sign in with' }) {
  const single = providers.length === 1;
  return (
    <div className="space-y-3">
      {showDivider && (
        <div className="flex items-center gap-3 text-[11px] uppercase tracking-[0.14em] text-muted-foreground/70">
          <div className="hairline-fade flex-1" />
          or continue with
          <div className="hairline-fade flex-1" />
        </div>
      )}
      <div className="flex flex-col gap-2">
        {providers.map((provider) => (
          <button
            key={provider.id ?? provider.presetId}
            type="button"
            onClick={() => onSelect(provider.id)}
            disabled={submitting}
            title={`${verb} ${provider.name || ssoLoginLabel(provider.presetId)}`}
            className={`inline-flex h-10 w-full min-w-0 items-center justify-center gap-2 rounded-md bg-foreground/[0.04] px-3 text-sm font-semibold text-foreground/85 ring-1 ring-foreground/[0.06] transition-colors hover:bg-foreground/[0.08] hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50`}
          >
            {submitting && single ? <Loader2 className="h-4 w-4 animate-spin" /> : <ProviderGlyph presetId={provider.presetId} />}
            <span className="truncate">
              {verb} {provider.name || ssoLoginLabel(provider.presetId)}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function Login() {
  const [step, setStep] = useState('email'); // 'email' | 'password' | 'mfa' | 'sent' | 'sso'
  // Why the SSO step is shown: 'required' (org requires SSO), 'single' (this
  // account signs in with one provider), 'multi' (pick a provider).
  const [ssoReason, setSsoReason] = useState('multi');
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
      if (opts.hasPassword && !opts.ssoRequired) {
        setStep('password');
      } else if (providers && providers.length > 0) {
        // No usable password (none set, or the org requires SSO) — show the
        // provider button(s) and let the person choose; never redirect away
        // without a click.
        setSsoStatus((prev) => ({
          ...prev,
          enabled: true,
          providers,
          orgSlug: opts.orgSlug || prev.orgSlug,
        }));
        setSsoReason(opts.ssoRequired ? 'required' : providers.length === 1 ? 'single' : 'multi');
        setStep('sso');
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
      } else if (err.code === 'SSO_REQUIRED') {
        setPassword('');
        setSsoReason('required');
        if (ssoStatus.enabled) setStep('sso');
        setError('Your organization signs in with single sign-on.');
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
    setSsoReason('multi');
    setPassword('');
    setError('');
    setLockout(null);
    setMfaChallenge(null);
  };

  const locked = !!lockout && retryRemaining > 0;

  const ssoList = ssoStatus.providers?.length
    ? ssoStatus.providers
    : [{ id: null, name: ssoLoginLabel(ssoStatus.presetId), presetId: ssoStatus.presetId }];

  const notice = (tone, children) => (
    <div
      className={
        tone === 'error'
          ? 'mx-auto max-w-xs text-center text-sm text-red-500 dark:text-red-400'
          : 'mx-auto max-w-sm text-center text-sm text-amber-700 dark:text-amber-300/90'
      }
      role={tone === 'error' ? 'alert' : undefined}
      aria-live="polite"
    >
      {children}
    </div>
  );

  return (
    <AuthShell
      logo="stacked"
      footer={
        registrationEnabled && (
          <>
            Don&apos;t have an account yet?{' '}
            <Link to="/register" className="font-medium text-foreground hover:underline underline-offset-4">
              Sign up.
            </Link>
          </>
        )
      }
    >
      <div className="w-full max-w-sm space-y-6">
        {isDeleted &&
          notice(
            'warn',
            'Your account has been deleted. If this was a mistake, contact your administrator within 30 days.'
          )}
        {sessionRevoked && !isDeleted &&
          notice(
            'warn',
            <span className="inline-flex items-start gap-1.5">
              <LogOut className="mt-0.5 h-4 w-4 shrink-0" />
              You were signed out because your session was revoked or your account changed.
            </span>
          )}

        <div className="text-center">
          <h1 className="sr-only">
            {step === 'mfa' ? 'Verify it’s you' : step === 'sent' ? 'Check your inbox' : 'Sign in'}
          </h1>
          <p className="mx-auto max-w-[20rem] text-[0.9375rem] leading-relaxed text-muted-foreground">
            {step === 'password'
              ? 'Enter your password to continue.'
              : step === 'sso'
                ? ssoReason === 'required'
                  ? 'Your organization signs in with single sign-on.'
                  : ssoReason === 'single'
                    ? `This account signs in with ${ssoStatus.providers?.[0]?.name || ssoLoginLabel(ssoStatus.providers?.[0]?.presetId)}.`
                    : 'Your organization signs you in with single sign-on.'
                : step === 'mfa'
                  ? 'One more step to keep your account safe.'
                  : step === 'sent'
                    ? 'We’ve sent a link to set your password.'
                    : 'Sign in with your work email, or continue with your organization.'}
          </p>
        </div>

        {step === 'sent' ? (
          <div className="space-y-5 text-center">
            <Mail className="mx-auto h-8 w-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              If <span className="text-foreground">{email}</span> has an account, the link is on its way.
            </p>
            <button type="button" onClick={resetToEmail} className="text-sm font-medium text-foreground hover:underline underline-offset-4">
              Use a different email
            </button>
          </div>
        ) : step === 'sso' ? (
          <div className="space-y-4">
            <p className="text-center text-sm text-muted-foreground">
              <span className="text-foreground">{email}</span>
            </p>
            <SsoTextButtons
              providers={ssoStatus.providers}
              submitting={ssoSubmitting}
              onSelect={(id) => handleSsoLogin(id)}
              showDivider={false}
              verb={ssoReason === 'single' ? 'Continue with' : 'Sign in with'}
            />
            {error && ssoReason !== 'required' && notice('error', error)}
            <button type="button" onClick={resetToEmail} className="block w-full text-center text-sm text-muted-foreground hover:text-foreground">
              Use a different email
            </button>
          </div>
        ) : step === 'mfa' ? (
          <div className="rounded-xl bg-foreground/[0.03] p-5 ring-1 ring-foreground/[0.06]">
            <MfaChallenge
              mfaToken={mfaChallenge?.mfaToken}
              methods={mfaChallenge?.methods}
              emailHint={mfaChallenge?.emailHint}
              onSuccess={handleMfaSuccess}
              onStartOver={resetToEmail}
            />
          </div>
        ) : (
          <form onSubmit={step === 'password' ? handleSubmit : handleContinue} className="space-y-4">
            {step === 'password' ? (
              <>
                <button
                  type="button"
                  onClick={resetToEmail}
                  className="mx-auto flex max-w-full items-center gap-2 rounded-full bg-foreground/[0.05] px-3 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
                  title="Use a different email"
                >
                  <span className="truncate">{email}</span>
                  <span className="text-foreground/60">Change</span>
                </button>
                <PillField
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Password"
                  aria-label="Password"
                  required
                  autoFocus
                  busy={submitting}
                  disabled={locked}
                  submitLabel="Sign in"
                  trailing={
                    <button
                      type="button"
                      onClick={() => setShowPassword((p) => !p)}
                      className="rounded-full p-2 text-muted-foreground hover:text-foreground"
                      aria-label={showPassword ? 'Hide password' : 'Show password'}
                      tabIndex={-1}
                    >
                      {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  }
                />
                <div className="text-center">
                  <Link to="/forgot-password" className="text-xs text-muted-foreground hover:text-foreground">
                    Forgot password?
                  </Link>
                </div>
              </>
            ) : (
              <PillField
                id="email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="Work email"
                aria-label="Email"
                required
                autoFocus
                busy={continuing}
                disabled={ssoSubmitting}
                submitLabel="Continue"
              />
            )}

            {error &&
              notice(
                'error',
                <span className="inline-flex items-start gap-1.5">
                  {locked && <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />}
                  <span>
                    {error}
                    {locked && (
                      <>
                        {' '}Try again in <span className="font-medium tabular-nums">{formatRetry(retryRemaining)}</span>.
                      </>
                    )}
                  </span>
                </span>
              )}

            {step === 'email' && ssoStatus.enabled && (
              <SsoTextButtons providers={ssoList} submitting={ssoSubmitting} onSelect={(id) => handleSsoLogin(id)} />
            )}
          </form>
        )}
      </div>
    </AuthShell>
  );
}

export default Login;
