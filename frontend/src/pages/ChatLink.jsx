import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { CheckCircle2, Loader2, XCircle } from 'lucide-react';
import AuthShell from '@/components/auth/AuthShell';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/context/AuthContext';
import { getPendingChatLink, confirmChatLink } from '@/services/chatIdentityService';
import { platformLabel, platformIcon } from '@/components/profile/chatIdentityHelpers';

/**
 * /chat/link?token=… — completes linking a chat account (Slack today) to the
 * signed-in Shellius user. Pressing approve/deny in chat proves the chat
 * half of the binding; visiting this link while signed in to Shellius proves
 * the other half — neither is enough alone (see
 * backend/src/services/notify/chatIdentityService.js). Sibling of
 * SsoLinkApprove.jsx, which is the same shape for an emailed SSO approval.
 */
export default function ChatLink() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { isAuthenticated, loading: authLoading } = useAuth();
  const ran = useRef(false);
  const [token, setToken] = useState(null);
  const [pending, setPending] = useState(null);
  const [phase, setPhase] = useState('loading'); // loading | review | done | fatal
  const [fatalMessage, setFatalMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const t = searchParams.get('token');

  // Not signed in — send to /login with a redirect back to this exact URL
  // (including the token) so the person returns here after signing in.
  useEffect(() => {
    if (authLoading) return;
    if (!isAuthenticated) {
      const dest = `${window.location.pathname}${window.location.search}`;
      navigate(`/login?redirect=${encodeURIComponent(dest)}`, { replace: true });
    }
  }, [authLoading, isAuthenticated, navigate]);

  useEffect(() => {
    if (authLoading || !isAuthenticated) return;
    if (ran.current) return;
    ran.current = true;
    setToken(t);
    if (!t) {
      setFatalMessage('This link is missing its token. Press the button in chat again.');
      setPhase('fatal');
      return;
    }
    getPendingChatLink(t)
      .then((data) => {
        setPending(data);
        setPhase('review');
      })
      .catch((err) => {
        setFatalMessage(
          err?.response?.data?.error?.message || 'That link is no longer valid. Press the button in chat again.'
        );
        setPhase('fatal');
      });
  }, [authLoading, isAuthenticated, t]);

  const confirm = async () => {
    setBusy(true);
    setError('');
    try {
      await confirmChatLink(token);
      setPhase('done');
    } catch (err) {
      const message =
        err?.response?.data?.error?.message || err?.message || 'Could not link that account. Try again.';
      const status = err?.response?.status;
      if (status === 409 || status === 403 || status === 410) {
        setFatalMessage(message);
        setPhase('fatal');
      } else {
        setError(message);
      }
    } finally {
      setBusy(false);
    }
  };

  const label = platformLabel(pending?.platform);
  const Icon = platformIcon(pending?.platform);

  return (
    <AuthShell>
      <div className="w-full max-w-sm">
        <div className="rounded-lg border border-border bg-card p-6 shadow-sm">
          {(phase === 'loading' || authLoading || !isAuthenticated) && (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          )}

          {phase === 'fatal' && (
            <div className="space-y-4 text-center">
              <XCircle className="mx-auto h-8 w-8 text-destructive" />
              <h1 className="text-base font-semibold text-foreground">This link can&apos;t be used</h1>
              <p className="text-sm text-muted-foreground">{fatalMessage}</p>
              <Link to="/profile" className="text-sm text-primary underline-offset-4 hover:underline">
                Go to your profile
              </Link>
            </div>
          )}

          {phase === 'review' && pending && (
            <div className="space-y-5">
              <div className="space-y-2 text-center">
                <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-foreground/[0.05]">
                  {Icon ? <Icon className="h-5 w-5 text-foreground/70" /> : null}
                </div>
                <h1 className="text-base font-semibold text-foreground">Link your {label} account?</h1>
                <p className="text-sm text-muted-foreground">
                  {pending.displayName ? (
                    <>
                      Connect <span className="font-medium text-foreground">{pending.displayName}</span> on {label} to
                      your Shellius account. You&apos;ll be able to approve and deny access requests from{' '}
                      {label} once it&apos;s linked.
                    </>
                  ) : (
                    <>
                      Connect this {label} account to your Shellius account. You&apos;ll be able to approve and deny
                      access requests from {label} once it&apos;s linked.
                    </>
                  )}
                </p>
              </div>
              {error && (
                <div role="alert" className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {error}
                </div>
              )}
              <Button className="w-full" onClick={confirm} disabled={busy}>
                {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Link {label}
              </Button>
            </div>
          )}

          {phase === 'done' && (
            <div className="space-y-4 text-center">
              <CheckCircle2 className="mx-auto h-8 w-8 text-emerald-600 dark:text-emerald-400" />
              <h1 className="text-base font-semibold text-foreground">{label} linked</h1>
              <p className="text-sm text-muted-foreground">
                Go back to {label} and press the button again — it will go through this time.
              </p>
              <Button className="w-full" onClick={() => navigate('/profile', { replace: true })}>
                Go to your profile
              </Button>
            </div>
          )}
        </div>
      </div>
    </AuthShell>
  );
}
