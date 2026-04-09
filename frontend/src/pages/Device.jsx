import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Loader2, Check, X } from 'lucide-react';
import { BrandMark } from '@/components/common/BrandLogo';
import api from '@/services/api';
import { useAuth } from '@/context/AuthContext';

function Device() {
  const [params] = useSearchParams();
  const [code, setCode] = useState(params.get('user_code') || '');
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState('');
  const { isAuthenticated, loading } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (!loading && !isAuthenticated) {
      navigate('/login?redirect=' + encodeURIComponent('/device?user_code=' + code), { replace: true });
    }
  }, [isAuthenticated, loading, code, navigate]);

  const submit = async (decision) => {
    setError('');
    setStatus(decision === 'approve' ? 'approving' : 'denying');
    try {
      await api.post(`/auth/device/${decision}`, { user_code: code.trim().toUpperCase() });
      setStatus(decision === 'approve' ? 'approved' : 'denied');
    } catch (e) {
      setStatus('idle');
      setError(e.response?.data?.error?.message || e.response?.data?.error || e.message || 'Failed');
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex justify-center">
            <BrandMark size="lg" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Device Login</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Confirm the code shown in your terminal
          </p>
        </div>

        <div className="rounded-lg border border-border bg-card p-6 shadow-sm">
          {status === 'approved' && (
            <div className="flex flex-col items-center gap-3 py-6 text-center">
              <Check className="h-10 w-10 text-emerald-500" />
              <p className="text-sm text-foreground">Device approved. You can return to your terminal.</p>
            </div>
          )}
          {status === 'denied' && (
            <div className="flex flex-col items-center gap-3 py-6 text-center">
              <X className="h-10 w-10 text-destructive" />
              <p className="text-sm text-foreground">Device denied.</p>
            </div>
          )}

          {status !== 'approved' && status !== 'denied' && (
            <>
              {error && (
                <div className="mb-3 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {error}
                </div>
              )}
              <label className="mb-1.5 block text-sm font-medium text-foreground">
                User code
              </label>
              <input
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                placeholder="ABCD1234"
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-center font-mono text-lg tracking-widest text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                autoFocus
              />
              <div className="mt-4 flex gap-2">
                <button
                  onClick={() => submit('approve')}
                  disabled={!code || status !== 'idle'}
                  className="flex h-9 flex-1 items-center justify-center rounded-md bg-primary text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                >
                  {status === 'approving' ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Approve'}
                </button>
                <button
                  onClick={() => submit('deny')}
                  disabled={!code || status !== 'idle'}
                  className="flex h-9 flex-1 items-center justify-center rounded-md border border-input bg-background text-sm font-medium text-foreground hover:bg-accent disabled:opacity-50"
                >
                  {status === 'denying' ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Deny'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default Device;
