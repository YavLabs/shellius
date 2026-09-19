import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Loader2, Lock, Mail, MailWarning, XCircle } from 'lucide-react';
import AuthShell from '@/components/auth/AuthShell';
import ProviderGlyph from '@/components/auth/ProviderGlyph';
import PasswordInput from '@/components/ui/PasswordInput';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/context/AuthContext';
import { EmailCodeResend, EmailCodeSend, EmailCodeSentNotice, useEmailCode } from '@/components/mfa/EmailCode';
import MoreWays, { methodLabel } from '@/components/mfa/MoreWays';
import {
  getPendingLink,
  confirmPendingLink,
  sendPendingLinkCode,
  cancelPendingLink,
} from '@/services/ssoConfigService';

const INPUT =
  'h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring';


function readParams() {
  const hash = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : window.location.hash;
  const fromHash = new URLSearchParams(hash);
  const fromQuery = new URLSearchParams(window.location.search);
  const get = (k) => fromHash.get(k) || fromQuery.get(k);
  return { token: get('token'), status: get('status'), provider: get('provider') };
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

function ErrorBox({ children }) {
  return (
    <div role="alert" className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
      {children}
    </div>
  );
}

/**
 * /sso/link — an SSO sign-in matched an existing account by email, and that
 * account must confirm before the provider is linked
 * (docs/auth-hardening.md "Linking SSO accounts").
 *
 *   #token=…                      confirm with the account's password, then
 *                                 the MFA code if enrolled → signed in
 *   #status=approval_sent         privileged SSO-only account: an approval
 *                                 link was emailed
 *   #status=approval_failed       …but the email couldn't be sent
 */
export default function SsoLink() {
  const navigate = useNavigate();
  const { loginWithTokens } = useAuth();
  const ran = useRef(false);

  const [params, setParams] = useState({ token: null, status: null, provider: null });
  const [info, setInfo] = useState(null);
  const [phase, setPhase] = useState('loading'); // loading | password | mfa | fatal | approval_sent | approval_failed
  const [fatal, setFatal] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const [password, setPassword] = useState('');
  const [methods, setMethods] = useState([]);
  const [emailHint, setEmailHint] = useState('');
  const [method, setMethod] = useState('totp');
  const [code, setCode] = useState('');

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    const p = readParams();
    setParams(p);
    // The token has no business staying in the address bar or history.
    window.history.replaceState(null, '', window.location.pathname);

    if (p.status === 'approval_sent' || p.status === 'approval_failed') {
      setPhase(p.status);
      return;
    }
    if (!p.token) {
      setFatal('This link request has expired or was already used. Sign in again to continue.');
      setPhase('fatal');
      return;
    }
    getPendingLink(p.token)
      .then((data) => {
        setInfo(data);
        setPhase('password');
      })
      .catch(() => {
        setFatal('This link request has expired or was already used. Sign in again to continue.');
        setPhase('fatal');
      });
  }, []);

  const providerName = info?.providerName || params.provider || 'SSO';

  const finish = async (data) => {
    await loginWithTokens({ accessToken: data.accessToken, refreshToken: data.refreshToken });
    navigate(safeRedirectDest(), { replace: true });
  };

  const handleError = (err, fallback) => {
    const body = err?.response?.data?.error;
    const c = body?.code;
    if (c === 'LINK_EXPIRED' || c === 'LINK_TOO_MANY_ATTEMPTS' || c === 'ACCOUNT_DISABLED') {
      setFatal(
        c === 'LINK_TOO_MANY_ATTEMPTS'
          ? 'Too many attempts. Sign in again to start over.'
          : c === 'ACCOUNT_DISABLED'
            ? 'This account has been disabled. Contact your administrator.'
            : 'This link request has expired or was already used. Sign in again to continue.'
      );
      setPhase('fatal');
      return;
    }
    if (c === 'INVALID_CREDENTIALS') setError('Incorrect password.');
    else if (c === 'ACCOUNT_LOCKED') setError('Too many failed attempts — this account is temporarily locked. Try again later.');
    else if (c === 'MFA_INVALID') setError('Invalid verification code. Please try again.');
    else setError(body?.message || err?.message || fallback);
  };

  const submitPassword = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const data = await confirmPendingLink({ token: params.token, password });
      setPassword('');
      if (data?.linkMfaRequired) {
        const primary = (data.methods || []).filter((m) => m !== 'backup');
        setMethods(data.methods || []);
        setMethod(primary[0] || data.methods?.[0] || 'totp');
        setEmailHint(data.emailHint || '');
        setPhase('mfa');
        return;
      }
      await finish(data);
    } catch (err) {
      handleError(err, 'Could not link the account.');
    } finally {
      setBusy(false);
    }
  };

  const submitCode = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const data = await confirmPendingLink({ token: params.token, method, code: code.trim() });
      await finish(data);
    } catch (err) {
      setCode('');
      handleError(err, 'Verification failed.');
    } finally {
      setBusy(false);
    }
  };

  // Email codes: send first, then the code field; resend with a cooldown.
  // Expired / locked link errors still end the flow (handleError).
  const email = useEmailCode(
    useCallback(async () => {
      try {
        await sendPendingLinkCode(params.token);
      } catch (err) {
        const c = err?.response?.data?.error?.code;
        if (c === 'LINK_EXPIRED' || c === 'LINK_TOO_MANY_ATTEMPTS' || c === 'ACCOUNT_DISABLED') handleError(err);
        throw err;
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [params.token])
  );
  const awaitingEmail = method === 'email' && !email.sent;

  const cancel = async () => {
    if (params.token) await cancelPendingLink(params.token).catch(() => {});
    navigate('/login', { replace: true });
  };

  return (
    <AuthShell>
      <div className="w-full max-w-sm">
        <div className="rounded-lg border border-border bg-card p-6 shadow-sm">
          {phase === 'loading' && (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          )}

          {phase === 'fatal' && (
            <div className="space-y-4 text-center">
              <XCircle className="mx-auto h-8 w-8 text-destructive" />
              <p className="text-sm text-muted-foreground">{fatal}</p>
              <Link to="/login" className="text-sm text-primary underline-offset-4 hover:underline">
                Back to sign in
              </Link>
            </div>
          )}

          {phase === 'approval_sent' && (
            <div className="space-y-4 text-center">
              <Mail className="mx-auto h-8 w-8 text-muted-foreground" />
              <h1 className="text-base font-semibold text-foreground">Check your email to approve linking</h1>
              <p className="text-sm text-muted-foreground">
                Your account has administrative permissions, so linking {providerName} needs approval. We sent a
                one-time link to your account&apos;s email address. Open it to link {providerName}, then sign in
                with {providerName} again.
              </p>
              <Link to="/login" className="text-sm text-primary underline-offset-4 hover:underline">
                Back to sign in
              </Link>
            </div>
          )}

          {phase === 'approval_failed' && (
            <div className="space-y-4 text-center">
              <MailWarning className="mx-auto h-8 w-8 text-amber-600 dark:text-amber-400" />
              <h1 className="text-base font-semibold text-foreground">We couldn&apos;t send the approval email</h1>
              <p className="text-sm text-muted-foreground">
                Linking {providerName} to an account with administrative permissions needs approval by email, and
                the email couldn&apos;t be sent. Ask an administrator to check the email (SMTP) settings, or to send
                you a password reset link so you can confirm with a password instead.
              </p>
              <Link to="/login" className="text-sm text-primary underline-offset-4 hover:underline">
                Back to sign in
              </Link>
            </div>
          )}

          {(phase === 'password' || phase === 'mfa') && info && (
            <div className="space-y-5">
              <div className="space-y-2 text-center">
                <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-foreground/[0.05]">
                  <ProviderGlyph presetId={info.presetId} />
                </div>
                <h1 className="text-base font-semibold text-foreground">Link your {providerName} account?</h1>
                <p className="text-sm text-muted-foreground">
                  Link your {providerName} account{' '}
                  <span className="font-medium text-foreground">{info.identityEmail}</span> to your Shellius account
                  <span className="text-foreground"> {info.accountEmail}</span>? After this you can sign in with{' '}
                  {providerName}.
                </p>
              </div>

              {error && <ErrorBox>{error}</ErrorBox>}

              {phase === 'password' ? (
                <form onSubmit={submitPassword} className="space-y-4">
                  <div>
                    <label htmlFor="link-password" className="mb-1.5 block text-sm font-medium text-foreground">
                      Your Shellius password
                    </label>
                    <PasswordInput
                      id="link-password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      autoComplete="current-password"
                      autoFocus
                      required
                      className={INPUT}
                    />
                    <p className="mt-1 text-xs text-muted-foreground">
                      This confirms the account is yours.
                      {info.mfaRequired ? ' You’ll also be asked for your two-factor code.' : ''}
                    </p>
                  </div>
                  <Button type="submit" className="w-full" disabled={busy || !password}>
                    {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Lock className="mr-2 h-4 w-4" />}
                    Link and sign in
                  </Button>
                  <div className="text-center">
                    <MoreWays
                      methods={methods}
                      method={method}
                      onChange={(m) => {
                        setMethod(m);
                        setCode('');
                        setError('');
                      }}
                    />
                  </div>
                  <Button type="button" variant="ghost" className="w-full" onClick={cancel} disabled={busy}>
                    Cancel
                  </Button>
                </form>
              ) : (
                <form onSubmit={submitCode} className="space-y-4">
                  <p className="text-sm text-muted-foreground">Enter a verification code to finish.</p>
                  <p className="text-sm font-medium text-foreground">{methodLabel(method)}</p>
                  {awaitingEmail ? (
                    <EmailCodeSend state={email} emailHint={emailHint} />
                  ) : (
                    <>
                      {method === 'email' && <EmailCodeSentNotice state={email} emailHint={emailHint} />}
                      <div>
                        <label htmlFor="link-code" className="mb-1.5 block text-sm font-medium text-foreground">
                          {method === 'backup' ? 'Backup code' : 'Verification code'}
                        </label>
                        <input
                          id="link-code"
                          value={code}
                          onChange={(e) => setCode(e.target.value)}
                          autoFocus
                          autoComplete="one-time-code"
                          inputMode={method === 'backup' ? 'text' : 'numeric'}
                          maxLength={method === 'backup' ? 14 : 6}
                          placeholder={method === 'backup' ? 'xxxx-xxxx-xxxx' : '6-digit code'}
                          className={`${INPUT} tracking-widest`}
                        />
                      </div>
                      <Button type="submit" className="w-full" disabled={busy || !code.trim()}>
                        {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                        Verify and sign in
                      </Button>
                      {method === 'email' && <EmailCodeResend state={email} />}
                    </>
                  )}
                  <Button type="button" variant="ghost" className="w-full" onClick={cancel} disabled={busy}>
                    Cancel
                  </Button>
                </form>
              )}
            </div>
          )}
        </div>
      </div>
    </AuthShell>
  );
}
