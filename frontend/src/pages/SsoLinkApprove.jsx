import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { CheckCircle2, Loader2, ShieldAlert, XCircle } from 'lucide-react';
import AuthShell from '@/components/auth/AuthShell';
import ProviderGlyph from '@/components/auth/ProviderGlyph';
import { Button } from '@/components/ui/button';
import { getLinkApproval, approveLink, cancelPendingLink } from '@/services/ssoConfigService';

/**
 * /sso/link/approve?token=… — the emailed approval for linking an SSO account
 * to a privileged account that has no password (docs/auth-hardening.md
 * "Linking SSO accounts"). Approving links the identity; it does not sign
 * anyone in — the person then signs in with the provider.
 */
export default function SsoLinkApprove() {
  const navigate = useNavigate();
  const ran = useRef(false);
  const [token, setToken] = useState(null);
  const [info, setInfo] = useState(null);
  const [phase, setPhase] = useState('loading'); // loading | review | done | declined | fatal
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    const q = new URLSearchParams(window.location.search);
    const h = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    const t = q.get('token') || h.get('token');
    window.history.replaceState(null, '', window.location.pathname);
    setToken(t);
    if (!t) {
      setPhase('fatal');
      return;
    }
    getLinkApproval(t)
      .then((data) => {
        setInfo(data);
        setPhase('review');
      })
      .catch(() => setPhase('fatal'));
  }, []);

  const approve = async () => {
    setBusy(true);
    setError('');
    try {
      await approveLink(token);
      setPhase('done');
    } catch (err) {
      const body = err?.response?.data?.error;
      if (body?.code === 'LINK_EXPIRED') setPhase('fatal');
      else setError(body?.message || err?.message || 'Could not approve the link.');
    } finally {
      setBusy(false);
    }
  };

  const decline = async () => {
    setBusy(true);
    await cancelPendingLink(token).catch(() => {});
    setBusy(false);
    setPhase('declined');
  };

  const providerName = info?.providerName || 'SSO';

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
              <h1 className="text-base font-semibold text-foreground">This approval link is no longer valid</h1>
              <p className="text-sm text-muted-foreground">
                It has expired or was already used. Sign in with your provider again to get a new one.
              </p>
              <Link to="/login" className="text-sm text-primary underline-offset-4 hover:underline">
                Back to sign in
              </Link>
            </div>
          )}

          {phase === 'review' && info && (
            <div className="space-y-5">
              <div className="space-y-2 text-center">
                <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-foreground/[0.05]">
                  <ProviderGlyph presetId={info.presetId} />
                </div>
                <h1 className="text-base font-semibold text-foreground">Approve linking {providerName}?</h1>
                <p className="text-sm text-muted-foreground">
                  Someone signed in with the {providerName} account{' '}
                  <span className="font-medium text-foreground">{info.identityEmail}</span> and asked to link it to
                  your Shellius account <span className="text-foreground">{info.accountEmail}</span>.
                </p>
              </div>
              <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
                <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  Only approve if you just tried to sign in with {providerName} yourself. If you didn&apos;t, choose
                  &quot;Don&apos;t link&quot; and tell your administrator.
                </span>
              </div>
              {error && (
                <div role="alert" className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {error}
                </div>
              )}
              <div className="space-y-2">
                <Button className="w-full" onClick={approve} disabled={busy}>
                  {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  Approve and link
                </Button>
                <Button variant="ghost" className="w-full" onClick={decline} disabled={busy}>
                  Don&apos;t link
                </Button>
              </div>
            </div>
          )}

          {phase === 'done' && (
            <div className="space-y-4 text-center">
              <CheckCircle2 className="mx-auto h-8 w-8 text-emerald-600 dark:text-emerald-400" />
              <h1 className="text-base font-semibold text-foreground">{providerName} linked</h1>
              <p className="text-sm text-muted-foreground">You can now sign in with {providerName}.</p>
              <Button className="w-full" onClick={() => navigate('/login', { replace: true })}>
                Continue to sign in
              </Button>
            </div>
          )}

          {phase === 'declined' && (
            <div className="space-y-4 text-center">
              <XCircle className="mx-auto h-8 w-8 text-muted-foreground" />
              <h1 className="text-base font-semibold text-foreground">Not linked</h1>
              <p className="text-sm text-muted-foreground">
                Nothing was changed. If you didn&apos;t start this, tell your administrator.
              </p>
              <Link to="/login" className="text-sm text-primary underline-offset-4 hover:underline">
                Back to sign in
              </Link>
            </div>
          )}
        </div>
      </div>
    </AuthShell>
  );
}
