import { useState, useEffect } from 'react';
import { useParams, useSearchParams, Link } from 'react-router-dom';
import { Loader2, CheckCircle2, XCircle, ShieldCheck } from 'lucide-react';
import { BrandMark } from '@/components/common/BrandLogo';
import { getApprovalRequest, submitApprovalDecision } from '@/services/approvalService';

function fmtDuration(seconds) {
  const mins = Math.round((seconds || 0) / 60);
  if (mins >= 60) {
    const h = Math.round((mins / 60) * 10) / 10;
    return `${h} hour${h === 1 ? '' : 's'}`;
  }
  return `${mins} minute${mins === 1 ? '' : 's'}`;
}

function ApproveRequest() {
  const { token } = useParams();
  const [searchParams] = useSearchParams();
  const intent = searchParams.get('intent'); // 'approve' | 'reject' | null

  const [request, setRequest] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [loading, setLoading] = useState(true);

  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null); // { decision, status }
  const [error, setError] = useState('');

  useEffect(() => {
    setLoading(true);
    getApprovalRequest(token)
      .then((data) => setRequest(data))
      .catch((err) => {
        const status = err?.response?.status;
        if (status === 409) setLoadError('This approval link has already been used.');
        else if (status === 410) setLoadError('This approval link has expired.');
        else setLoadError('This approval link is invalid or has expired.');
      })
      .finally(() => setLoading(false));
  }, [token]);

  const decide = async (decision) => {
    setError('');
    if (decision === 'reject' && !reason.trim()) {
      setError('Please provide a reason for rejecting.');
      return;
    }
    setSubmitting(true);
    try {
      const data = await submitApprovalDecision(token, decision, decision === 'reject' ? reason.trim() : undefined);
      setResult({ decision, status: data?.status });
    } catch (err) {
      const status = err?.response?.status;
      if (status === 409) {
        setError('This request has already been handled.');
      } else {
        setError(err?.response?.data?.error?.message || err.message || 'Failed to submit decision.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const env = request?.server?.environment;

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex justify-center">
            <BrandMark size="lg" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            {import.meta.env.VITE_BRAND_NAME || 'Shellius'}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">Access request approval</p>
        </div>

        <div className="rounded-lg border border-border bg-card p-6 shadow-sm">
          {loading && (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          )}

          {!loading && loadError && (
            <div className="space-y-4">
              <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {loadError}
              </div>
              <p className="text-center text-sm text-muted-foreground">
                <Link to="/login" className="text-primary underline-offset-4 hover:underline">
                  Go to sign in
                </Link>
              </p>
            </div>
          )}

          {!loading && !loadError && result && (
            <div className="space-y-4 text-center py-2">
              {result.decision === 'approve' ? (
                <CheckCircle2 className="mx-auto h-12 w-12 text-emerald-500" />
              ) : (
                <XCircle className="mx-auto h-12 w-12 text-destructive" />
              )}
              <p className="text-base font-semibold text-foreground">
                Request {result.decision === 'approve' ? 'approved' : 'rejected'}
              </p>
              <p className="text-sm text-muted-foreground">
                The requester has been notified. You can close this page.
              </p>
            </div>
          )}

          {!loading && !loadError && !result && request && (
            <div className="space-y-5">
              {request.status !== 'PENDING' ? (
                <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
                  This request is no longer pending (status: {request.status}). No action needed.
                </div>
              ) : (
                <>
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <ShieldCheck className="h-4 w-4" />
                    Review the request below, then approve or reject. No sign-in required.
                  </div>

                  <div className="rounded-md border border-border bg-muted/30 px-4 py-3 text-sm space-y-1.5">
                    <div>
                      <span className="text-muted-foreground">Requester:</span>{' '}
                      <span className="font-medium text-foreground">
                        {request.requester?.name || request.requester?.email || 'Unknown'}
                      </span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Server:</span>{' '}
                      <span className="font-medium text-foreground">
                        {request.server?.displayName || request.server?.hostname}
                      </span>{' '}
                      {env && (
                        <span className="ml-1 inline-block rounded bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase text-amber-700 dark:text-amber-400">
                          {env}
                        </span>
                      )}
                    </div>
                    <div>
                      <span className="text-muted-foreground">Login as:</span>{' '}
                      <span className="font-mono text-foreground">{request.requestedPrincipal}</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Duration:</span>{' '}
                      <span className="text-foreground">{fmtDuration(request.requestedDuration)}</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Reason:</span>{' '}
                      <span className="text-foreground">{request.reason}</span>
                    </div>
                  </div>

                  <div>
                    <label className="mb-1.5 block text-sm font-medium text-foreground">
                      Reason {intent === 'reject' ? '(required to reject)' : '(optional)'}
                    </label>
                    <textarea
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      rows={2}
                      placeholder="Add a note for the requester…"
                      className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                  </div>

                  {error && (
                    <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                      {error}
                    </div>
                  )}

                  <div className="flex gap-2">
                    <button
                      onClick={() => decide('approve')}
                      disabled={submitting}
                      className="flex h-9 flex-1 items-center justify-center gap-1.5 rounded-md bg-emerald-600 text-sm font-medium text-white transition-colors hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                      Approve
                    </button>
                    <button
                      onClick={() => decide('reject')}
                      disabled={submitting}
                      className="flex h-9 flex-1 items-center justify-center gap-1.5 rounded-md bg-destructive text-sm font-medium text-destructive-foreground transition-colors hover:bg-destructive/90 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <XCircle className="h-4 w-4" />}
                      Reject
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default ApproveRequest;
