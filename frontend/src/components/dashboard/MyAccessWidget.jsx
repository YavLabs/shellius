import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Shield, ShieldAlert, Server, ChevronRight } from 'lucide-react';
import EnvironmentBadge from '@/components/shared/EnvironmentBadge';
import { getMyAccess } from '@/services/policyService';

function formatMaxTtl(seconds) {
  if (!seconds || seconds <= 0) return '-';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h >= 24) return `up to ${Math.floor(h / 24)}d`;
  if (h > 0 && m > 0) return `up to ${h}h ${m}m`;
  if (h > 0) return `up to ${h}h`;
  return `up to ${m}m`;
}

function AccessRow({ entry }) {
  const navigate = useNavigate();
  const requiresApproval = entry.requiresApproval;
  const principals = Array.isArray(entry.principals) ? entry.principals : [];
  const serverId = entry.server?.id || entry.serverId;

  return (
    <button
      type="button"
      onClick={() => serverId && navigate(`/servers/${serverId}`)}
      className="group flex w-full items-center justify-between gap-3 py-2.5 text-left border-b border-border last:border-0 hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm px-1 -mx-1 transition-colors"
    >
      {/* Left: server icon + name + env badge + principals subline */}
      <div className="flex min-w-0 items-center gap-2">
        <Server className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-foreground">
              {entry.server?.hostname || entry.serverId}
            </span>
            {entry.server?.environment && (
              <EnvironmentBadge environment={entry.server.environment} />
            )}
          </div>
          {principals.length > 0 && (
            <p className="mt-0.5 truncate text-[11px] font-mono text-muted-foreground">
              {principals.slice(0, 3).join(', ')}
              {principals.length > 3 && ` +${principals.length - 3}`}
            </p>
          )}
        </div>
      </div>

      {/* Right: access label + ttl + chevron — single centered row */}
      <div className="flex shrink-0 items-center gap-3">
        {requiresApproval ? (
          <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/5 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-400">
            <ShieldAlert className="h-3 w-3" />
            Needs approval
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/5 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-400">
            <Shield className="h-3 w-3" />
            Direct access
          </span>
        )}
        {formatMaxTtl(entry.maxTtl) !== '-' && (
          <span className="whitespace-nowrap text-xs text-muted-foreground">
            {formatMaxTtl(entry.maxTtl)}
          </span>
        )}
        <ChevronRight className="h-4 w-4 text-muted-foreground/40 transition-colors group-hover:text-muted-foreground" />
      </div>
    </button>
  );
}

const LIMIT = 10;

function MyAccessWidget() {
  const [entries, setEntries] = useState([]);
  const [showAll, setShowAll] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    setLoading(true);
    setError('');
    getMyAccess()
      .then((data) => {
        const items = Array.isArray(data) ? data : data?.items || data?.accessibleServers || [];
        // The API returns { server, evaluation } — flatten the evaluation so the
        // row reads requiresApproval / principals / maxTtl correctly.
        const flat = items.map((it) => {
          const ev = it.evaluation || it;
          return {
            server: it.server || it.server,
            serverId: it.server?.id || it.serverId,
            customerName: it.server?.customer?.name || it.customerName || 'Other',
            requiresApproval: ev.requiresApproval,
            principals: ev.principals || [],
            maxTtl: ev.maxTtl,
          };
        });
        setEntries(flat);
      })
      .catch((err) => {
        setError(err.response?.data?.error?.message || 'Failed to load accessible servers');
      })
      .finally(() => setLoading(false));
  }, []);

  const totalCount = entries.length;
  const visible = showAll ? entries : entries.slice(0, LIMIT);
  const groups = {};
  visible.forEach((e) => {
    (groups[e.customerName] = groups[e.customerName] || []).push(e);
  });
  const customerNames = Object.keys(groups);

  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-sm font-semibold text-foreground">My Access</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Servers you are permitted to access
          </p>
        </div>
        {!loading && totalCount > 0 && (
          <span className="text-xs text-muted-foreground">{totalCount} server{totalCount === 1 ? '' : 's'}</span>
        )}
      </div>

      {loading && (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-10 rounded-md bg-muted/40 animate-pulse" />
          ))}
        </div>
      )}

      {!loading && error && (
        <p className="text-sm text-destructive">{error}</p>
      )}

      {!loading && !error && customerNames.length === 0 && (
        <div className="flex flex-col items-center justify-center py-8 text-center">
          <Shield className="h-8 w-8 text-muted-foreground/40 mb-2" />
          <p className="text-sm font-medium text-muted-foreground">No accessible servers yet</p>
          <p className="text-xs text-muted-foreground mt-1">
            Contact an admin to be added to an access policy.
          </p>
        </div>
      )}

      {!loading && !error && customerNames.length > 0 && (
        <div className="space-y-4">
          {customerNames.map((customerName) => (
            <div key={customerName}>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">
                {customerName}
              </p>
              <div>
                {groups[customerName].map((entry) => (
                  <AccessRow key={entry.serverId || entry.id} entry={entry} />
                ))}
              </div>
            </div>
          ))}

          {totalCount > LIMIT && (
            <button
              type="button"
              onClick={() => setShowAll((s) => !s)}
              className="w-full rounded-md border border-border py-2 text-xs font-medium text-muted-foreground hover:bg-accent/40 hover:text-foreground transition-colors"
            >
              {showAll ? 'Show less' : `View all ${totalCount} servers`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export default MyAccessWidget;
