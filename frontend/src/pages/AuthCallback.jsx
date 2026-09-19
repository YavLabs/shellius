import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2, XCircle } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import MfaChallenge from '@/components/auth/MfaChallenge';
import api from '@/services/api';
import AuthShell from '@/components/auth/AuthShell';

/**
 * What each `#error=` code means, in plain language. Mirrors the outcome map
 * pattern used elsewhere for auth callbacks — a vague failure is the worst
 * possible moment, since the person has no way to tell whether to retry, use
 * a different method, or contact an admin.
 */
const ERROR_MESSAGES = {
  domain_not_allowed: {
    title: "Your email domain isn't allowed",
    body: 'This organization only allows sign-in from specific email domains. Contact your administrator if you believe this is a mistake.',
  },
  org_not_allowed: {
    title: "Your GitHub account isn't a member of an allowed organization",
    body: 'This provider only allows sign-in from members of specific GitHub organizations. Contact your administrator if you believe this is a mistake.',
  },
  email_not_verified: {
    title: 'Email not verified by your identity provider',
    body: "We only link single sign-on to an existing account when the provider confirms the email address, and this one didn't. Sign in with your password instead, or ask an administrator for help.",
  },
  account_disabled: {
    title: 'This account has been disabled',
    body: 'Contact your administrator to restore access.',
  },
  provisioning_disabled: {
    title: "New accounts aren't created automatically",
    body: 'Ask an administrator to invite you, then try signing in with SSO again.',
  },
  identity_conflict: {
    title: 'This identity is linked to a different account',
    body: 'The email address from your identity provider is already associated with another sign-in method. Contact your administrator to resolve this.',
  },
  state_mismatch: {
    title: 'Sign-in session expired',
    body: 'The sign-in request could not be verified — this usually happens if it took too long, or was opened in another tab. Please try again.',
  },
  sso_not_configured: {
    title: "Single sign-on isn't configured",
    body: 'This organization has not set up SSO yet. Sign in with your email and password instead.',
  },
  sso_failed: {
    title: 'Sign-in failed',
    body: 'Something went wrong completing single sign-on. Nothing was changed on your account — please try again.',
  },
};

function errorInfoFor(code) {
  return ERROR_MESSAGES[code] || ERROR_MESSAGES.sso_failed;
}

function safeRedirectDest() {
  let dest = '/dashboard';
  try {
    const saved = sessionStorage.getItem('sso_redirect');
    if (saved && saved.startsWith('/') && !saved.startsWith('//')) dest = saved;
    sessionStorage.removeItem('sso_redirect');
  } catch {
    /* ignore */
  }
  return dest;
}

/**
 * AuthCallback — landing page for the SSO redirect.
 *
 * The backend never puts tokens in the URL: on success it redirects to
 * `/auth/callback#code=<one-time code>` and we exchange that code for a
 * login-shaped response (tokens, or an MFA challenge) via
 * POST /api/auth/sso/exchange. On failure it redirects to
 * `/auth/callback#error=<code>`.
 *
 * Two execution modes:
 *   1. Popup mode  — when window.opener exists, postMessage the result
 *      back to the parent window and close ourselves. The parent's
 *      Login page hydrates AuthContext and navigates.
 *   2. Tab/standalone mode — the primary flow (Login does a full-page
 *      redirect to the IdP). Complete sign-in in place.
 */
function AuthCallback() {
  const navigate = useNavigate();
  const { loginWithTokens, applyAuthResult } = useAuth();
  const [status, setStatus] = useState('working'); // working | mfa | error
  const [errorInfo, setErrorInfo] = useState(null);
  const [mfaChallenge, setMfaChallenge] = useState(null);
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;

    const hash = window.location.hash.startsWith('#')
      ? window.location.hash.slice(1)
      : window.location.hash;
    const params = new URLSearchParams(hash);
    const code = params.get('code');
    const errParam = params.get('error');

    // Clear the fragment immediately — a one-time code or error reason has no
    // business sitting in browser history / being replayable on refresh.
    window.history.replaceState(null, '', window.location.pathname + window.location.search);

    // The popup keeps window.name across the cross-origin IdP round-trip even
    // if COOP severs window.opener — use it to reliably detect popup mode.
    const isPopup = window.name === 'shellius-sso' || !!(window.opener && window.opener !== window);

    function finishPopup(payload) {
      try {
        window.opener?.postMessage(payload, window.location.origin);
      } catch {
        /* ignore */
      }
      try {
        localStorage.setItem('shellius_sso_msg', JSON.stringify({ ...payload, ts: Date.now() }));
      } catch {
        /* ignore */
      }
      if (!payload.ok) {
        setStatus('error');
        setErrorInfo(errorInfoFor(payload.error));
      }
      setTimeout(() => window.close(), payload.ok ? 200 : 1500);
    }

    if (errParam) {
      if (isPopup) {
        finishPopup({ type: 'shellius:sso', ok: false, error: errParam });
        return;
      }
      setStatus('error');
      setErrorInfo(errorInfoFor(errParam));
      return;
    }

    if (!code) {
      if (isPopup) {
        finishPopup({ type: 'shellius:sso', ok: false, error: 'sso_failed' });
        return;
      }
      setStatus('error');
      setErrorInfo(errorInfoFor('sso_failed'));
      return;
    }

    api
      .post('/auth/sso/exchange', { code })
      .then((res) => {
        const data = res.data?.data || {};

        if (data.mfaRequired) {
          if (isPopup) {
            // A detached popup can't run the inline MFA challenge — the
            // opener would have to re-enter it blind. Bail out and let the
            // user complete sign-in in the main tab instead.
            finishPopup({ type: 'shellius:sso', ok: false, error: 'sso_failed' });
            return;
          }
          setMfaChallenge(data);
          setStatus('mfa');
          return;
        }

        if (isPopup) {
          finishPopup({
            type: 'shellius:sso',
            ok: true,
            accessToken: data.accessToken,
            refreshToken: data.refreshToken,
          });
          return;
        }

        const dest = safeRedirectDest();
        loginWithTokens({ accessToken: data.accessToken, refreshToken: data.refreshToken })
          .then(() => navigate(dest, { replace: true }))
          .catch((e) => {
            setStatus('error');
            setErrorInfo({ title: 'Sign-in failed', body: e?.message || 'Failed to complete sign-in.' });
          });
      })
      .catch((err) => {
        const errCode = err?.response?.data?.error?.code;
        if (isPopup) {
          finishPopup({ type: 'shellius:sso', ok: false, error: errCode || 'sso_failed' });
          return;
        }
        setStatus('error');
        setErrorInfo(errorInfoFor(errCode));
      });
  }, [loginWithTokens, navigate]);

  const handleMfaSuccess = (data) => {
    applyAuthResult(data);
    navigate(safeRedirectDest(), { replace: true });
  };

  return (
    <AuthShell>
      <div className="w-full max-w-sm rounded-lg border border-border bg-card p-6 text-center shadow-sm">
        {status === 'working' && (
          <>
            <Loader2 className="mx-auto mb-3 h-8 w-8 animate-spin text-primary" />
            <h1 className="text-base font-semibold text-foreground">Signing you in…</h1>
            <p className="mt-1 text-xs text-muted-foreground">
              Completing single sign-on. This window will close automatically.
            </p>
          </>
        )}

        {status === 'mfa' && (
          <div className="text-left">
            <h1 className="mb-4 text-center text-base font-semibold text-foreground">
              Two-factor authentication
            </h1>
            <MfaChallenge
              mfaToken={mfaChallenge?.mfaToken}
              methods={mfaChallenge?.methods}
              emailHint={mfaChallenge?.emailHint}
              onSuccess={handleMfaSuccess}
              onStartOver={() => navigate('/login', { replace: true })}
            />
          </div>
        )}

        {status === 'error' && errorInfo && (
          <>
            <XCircle className="mx-auto mb-3 h-8 w-8 text-destructive" />
            <h1 className="text-base font-semibold text-foreground">{errorInfo.title}</h1>
            <p className="mt-1 text-xs text-muted-foreground break-words">{errorInfo.body}</p>
            <button
              type="button"
              onClick={() => (window.opener ? window.close() : navigate('/login'))}
              className="mt-4 text-xs text-primary underline-offset-4 hover:underline"
            >
              {window.opener ? 'Close window' : 'Back to sign in'}
            </button>
          </>
        )}
      </div>
    </AuthShell>
  );
}

export default AuthCallback;
