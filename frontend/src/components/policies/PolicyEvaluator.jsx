import { useState, useEffect } from 'react';
import { FlaskConical, ChevronDown } from 'lucide-react';
import Modal from '@/components/shared/Modal';
import { listUsers } from '@/services/userService';
import { listServers } from '@/services/serverService';
import { evaluatePolicy } from '@/services/policyService';

// Outcome badge colors
function OutcomeBadge({ outcome }) {
  const styles = {
    allow: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border border-emerald-500/30',
    deny: 'bg-destructive/10 text-destructive border border-destructive/30',
    requires_approval: 'bg-amber-500/15 text-amber-700 dark:text-amber-300 border border-amber-500/30',
  };
  const labels = {
    allow: 'Allow',
    deny: 'Deny',
    requires_approval: 'Requires Approval',
  };
  const cls = styles[outcome] || 'bg-muted text-muted-foreground border border-border';
  return (
    <span className={`inline-flex items-center rounded-full px-3 py-1 text-sm font-semibold ${cls}`}>
      {labels[outcome] || outcome}
    </span>
  );
}

function PolicyEvaluator({ open, onClose, policy }) {
  const [users, setUsers] = useState([]);
  const [servers, setServers] = useState([]);
  const [loadingData, setLoadingData] = useState(false);

  const [userId, setUserId] = useState('');
  const [serverId, setServerId] = useState('');
  const [result, setResult] = useState(null);
  const [evaluating, setEvaluating] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setResult(null);
    setError('');
    setLoadingData(true);
    Promise.all([
      listUsers({ limit: 200 }).then((d) => d?.users ?? d?.items ?? (Array.isArray(d) ? d : [])),
      listServers({ limit: 200 }).then((d) => d?.items ?? (Array.isArray(d) ? d : [])),
    ])
      .then(([u, s]) => {
        setUsers(u);
        setServers(s);
      })
      .catch(() => {})
      .finally(() => setLoadingData(false));
  }, [open]);

  const handleEvaluate = async () => {
    if (!userId || !serverId) return;
    setEvaluating(true);
    setError('');
    setResult(null);
    try {
      const body = { userId, serverId };
      // If policy has an id it's a saved policy, send policyId; otherwise send the draft
      if (policy?.id) {
        body.policyId = policy.id;
      } else {
        body.policy = policy;
      }
      const data = await evaluatePolicy(body);
      setResult(data);
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message || 'Evaluation failed');
    } finally {
      setEvaluating(false);
    }
  };

  const inputCls =
    'w-full h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring appearance-none';

  return (
    <Modal open={open} onClose={onClose} title="Policy Evaluator" size="md">
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Preview how this policy evaluates for a given user and server.
        </p>

        {loadingData ? (
          <div className="space-y-2">
            <div className="h-9 animate-pulse rounded bg-muted" />
            <div className="h-9 animate-pulse rounded bg-muted" />
          </div>
        ) : (
          <>
            <div>
              <label className="mb-1.5 block text-sm font-medium text-foreground">User</label>
              <div className="relative">
                <select
                  className={inputCls}
                  value={userId}
                  onChange={(e) => setUserId(e.target.value)}
                >
                  <option value="">Select a user...</option>
                  {users.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name || u.email} {u.name && u.email ? `(${u.email})` : ''}
                    </option>
                  ))}
                </select>
                <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              </div>
            </div>

            <div>
              <label className="mb-1.5 block text-sm font-medium text-foreground">Server</label>
              <div className="relative">
                <select
                  className={inputCls}
                  value={serverId}
                  onChange={(e) => setServerId(e.target.value)}
                >
                  <option value="">Select a server...</option>
                  {servers.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.hostname} ({s.environment})
                    </option>
                  ))}
                </select>
                <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              </div>
            </div>

            <button
              type="button"
              onClick={handleEvaluate}
              disabled={evaluating || !userId || !serverId}
              className="flex h-9 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              <FlaskConical className="h-4 w-4" />
              {evaluating ? 'Evaluating...' : 'Preview'}
            </button>
          </>
        )}

        {error && (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        {result && (
          <div className="rounded-lg border border-border bg-muted/20 p-4 space-y-3">
            <div className="flex items-center gap-3">
              <span className="text-sm font-medium text-foreground">Outcome:</span>
              <OutcomeBadge outcome={result.outcome} />
            </div>

            {result.matchedRule && (
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-1">
                  Matched Rule
                </p>
                <pre className="overflow-x-auto rounded border border-border bg-background px-3 py-2 text-xs text-foreground whitespace-pre-wrap break-all">
                  {typeof result.matchedRule === 'string'
                    ? result.matchedRule
                    : JSON.stringify(result.matchedRule, null, 2)}
                </pre>
              </div>
            )}

            {result.constraints && Object.keys(result.constraints).length > 0 && (
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-1">
                  Constraints
                </p>
                <dl className="space-y-1">
                  {Object.entries(result.constraints).map(([k, v]) => (
                    <div key={k} className="flex items-start gap-2 text-xs">
                      <dt className="w-40 shrink-0 font-medium text-muted-foreground">{k}</dt>
                      <dd className="text-foreground break-all">
                        {typeof v === 'object' ? JSON.stringify(v) : String(v)}
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}

export default PolicyEvaluator;
