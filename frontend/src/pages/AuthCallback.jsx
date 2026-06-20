import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2, CheckCircle2, XCircle } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';

/**
 * AuthCallback
 *
 * Landing page for the SSO redirect. The backend OIDC callback ends with
 *   res.redirect(`${FRONTEND_URL}/auth/callback#access_token=...&refresh_token=...`)
 * so we read the tokens from the URL fragment.
 *
 * Two execution modes:
 *   1. Popup mode  — when window.opener exists, postMessage the tokens
 *      back to the parent window and close ourselves. The parent's
 *      Login page hydrates AuthContext and navigates.
 *   2. Tab/standalone mode — fall through to in-place login: store the
 *      tokens via loginWithTokens and navigate to /dashboard.
 */
function AuthCallback() {
  const navigate = useNavigate();
  const { loginWithTokens } = useAuth();
  const [status, setStatus] = useState('working'); // working | error
  const [errorMsg, setErrorMsg] = useState('');

  useEffect(() => {
    const hash = window.location.hash.startsWith('#')
      ? window.location.hash.slice(1)
      : window.location.hash;
    const params = new URLSearchParams(hash);
    const accessToken = params.get('access_token');
    const refreshToken = params.get('refresh_token');
    const errParam = params.get('error');

    // The popup keeps window.name across the cross-origin IdP round-trip even if
    // COOP severs window.opener — use it to reliably detect popup mode.
    const isPopup = window.name === 'shellius-sso' || !!(window.opener && window.opener !== window);

    const payload = errParam
      ? { type: 'shellius:sso', ok: false, error: decodeURIComponent(errParam) }
      : accessToken && refreshToken
        ? { type: 'shellius:sso', ok: true, accessToken, refreshToken }
        : { type: 'shellius:sso', ok: false, error: 'Missing tokens in SSO callback URL' };

    if (isPopup) {
      // Primary: postMessage to opener. Fallback: localStorage fires a `storage`
      // event in the opener even when window.opener is null (COOP-severed).
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
        setErrorMsg(payload.error);
      }
      setTimeout(() => window.close(), payload.ok ? 200 : 1500);
      return;
    }

    // Standalone tab — store directly and continue.
    if (!payload.ok) {
      setStatus('error');
      setErrorMsg(payload.error);
      return;
    }
    loginWithTokens({ accessToken, refreshToken })
      .then(() => navigate('/dashboard', { replace: true }))
      .catch((e) => {
        setStatus('error');
        setErrorMsg(e?.message || 'Failed to complete SSO login');
      });
  }, [loginWithTokens, navigate]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
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
        {status === 'error' && (
          <>
            <XCircle className="mx-auto mb-3 h-8 w-8 text-destructive" />
            <h1 className="text-base font-semibold text-foreground">Sign-in failed</h1>
            <p className="mt-1 text-xs text-muted-foreground break-words">{errorMsg}</p>
            <button
              type="button"
              onClick={() => (window.opener ? window.close() : navigate('/login'))}
              className="mt-4 text-xs text-primary underline-offset-4 hover:underline"
            >
              {window.opener ? 'Close window' : 'Back to login'}
            </button>
          </>
        )}
        {status === 'success' && <CheckCircle2 className="mx-auto h-8 w-8 text-emerald-500" />}
      </div>
    </div>
  );
}

export default AuthCallback;
