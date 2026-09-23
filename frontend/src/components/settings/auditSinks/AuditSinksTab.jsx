import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, History, Info, Pencil, Play, Plus, ScrollText, Send, Trash2, Zap } from 'lucide-react';
import { SectionCard } from '@/components/settings/shared';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import ConfirmDialog from '@/components/shared/ConfirmDialog';
import { relativeTime, formatDateTime } from '@/utils/time';
import { listAuditSinks, deleteAuditSink, updateAuditSink, testAuditSink } from '@/services/auditSinkService';
import { getSinkType, sinkStatus, formatLag } from './sinkTypes';
import AuditSinkFormModal from './AuditSinkFormModal';
import AuditSinkDeliveriesModal from './AuditSinkDeliveriesModal';

function Notice({ tone = 'info', icon: Icon = Info, children }) {
  const tones = {
    info: 'border-blue-500/40 bg-blue-500/10 text-blue-700 dark:text-blue-300',
    warning: 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300',
    success: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
    danger: 'border-destructive/50 bg-destructive/10 text-destructive',
  };
  return (
    <div className={`flex items-start gap-2 rounded-md border px-3 py-2 text-sm ${tones[tone]}`}>
      <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function TestStatus({ sink }) {
  if (!sink.lastTestAt) return <span className="text-xs text-muted-foreground">Not tested yet</span>;
  if (sink.lastTestOk) {
    return (
      <div className="min-w-0 space-y-1">
        <Badge tone="success" dot title={formatDateTime(sink.lastTestAt)}>
          Test passed · {relativeTime(sink.lastTestAt)}
        </Badge>
        {sink.type === 'syslog' && (
          <p className="text-xs text-muted-foreground">A successful connection, not a delivery guarantee — syslog never confirms storage.</p>
        )}
      </div>
    );
  }
  return (
    <div className="min-w-0 space-y-1">
      <Badge tone="danger" dot title={formatDateTime(sink.lastTestAt)}>
        Test failed · {relativeTime(sink.lastTestAt)}
      </Badge>
      {sink.lastTestError && <p className="break-words text-xs text-destructive">{sink.lastTestError}</p>}
    </div>
  );
}

function SinkCard({ sink, onEdit, onDelete, onToggleActive, onTest, onDeliveries, testingId }) {
  const def = getSinkType(sink.type);
  const Icon = def?.icon || ScrollText;
  const status = sinkStatus(sink);
  const lagText = sink.streaming ? formatLag(sink.lag) : null;
  const testing = testingId === sink.id;

  return (
    <div
      className={[
        'rounded-lg border bg-card p-4',
        sink.disabledReason ? 'border-destructive/40' : sink.isActive ? 'border-border' : 'border-border opacity-80',
      ].join(' ')}
    >
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border bg-muted/40">
          <Icon className="h-4 w-4 text-foreground" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="truncate text-sm font-semibold text-foreground">{sink.name}</p>
            <Badge tone="neutral" variant="outline">
              {def?.label || sink.type}
            </Badge>
            <Badge tone={status.tone} dot>
              {status.label}
            </Badge>
            {!sink.streaming && (
              <Badge tone="info" variant="outline">
                Digest, not a stream
              </Badge>
            )}
          </div>

          {(sink.filters?.actions?.length || sink.filters?.resourceTypes?.length) ? (
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              Filtered
              {sink.filters?.actions?.length ? ` · ${sink.filters.actions.length} action${sink.filters.actions.length === 1 ? '' : 's'}` : ''}
              {sink.filters?.resourceTypes?.length
                ? ` · ${sink.filters.resourceTypes.length} resource type${sink.filters.resourceTypes.length === 1 ? '' : 's'}`
                : ''}
            </p>
          ) : (
            <p className="mt-0.5 text-xs text-muted-foreground">Every action and resource type</p>
          )}

          {sink.disabledReason && (
            <p className="mt-1.5 flex items-start gap-1.5 text-xs font-medium text-destructive">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              {sink.disabledReason}
            </p>
          )}
          {!sink.disabledReason && sink.notReadyReason && (
            <p className="mt-1.5 text-xs text-amber-700 dark:text-amber-400">{sink.notReadyReason}</p>
          )}

          <p className="mt-1.5 text-xs text-muted-foreground">
            {sink.lastOkAt ? `Last delivered ${relativeTime(sink.lastOkAt)}` : 'Nothing delivered yet'}
            {sink.lastError && !sink.disabledReason ? ` — retrying: ${sink.lastError}` : ''}
          </p>

          {sink.streaming && sink.isActive && !sink.disabledReason && (
            <p className="mt-0.5 text-xs text-muted-foreground">
              {lagText || 'Lag unknown'} · runs about 5 seconds behind live, by design, so no entry is missed
            </p>
          )}

          <div className="mt-2">
            <TestStatus sink={sink} />
          </div>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-2 border-t border-border pt-3">
        <Button size="sm" variant="outline" onClick={() => onTest(sink)} disabled={testing}>
          <Send className="mr-1.5 h-3.5 w-3.5" />
          {testing ? 'Testing…' : 'Test'}
        </Button>
        <Button size="sm" variant="outline" onClick={() => onDeliveries(sink)}>
          <History className="mr-1.5 h-3.5 w-3.5" />
          Recent deliveries
        </Button>
        <Button size="sm" variant="ghost" onClick={() => onEdit(sink)}>
          <Pencil className="mr-1.5 h-3.5 w-3.5" />
          Edit
        </Button>
        <Button size="sm" variant="ghost" onClick={() => onToggleActive(sink)}>
          {sink.isActive ? (
            <>
              <Zap className="mr-1.5 h-3.5 w-3.5" />
              Disable
            </>
          ) : (
            <>
              <Play className="mr-1.5 h-3.5 w-3.5" />
              Enable
            </>
          )}
        </Button>
        <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => onDelete(sink)}>
          <Trash2 className="mr-1.5 h-3.5 w-3.5" />
          Delete
        </Button>
      </div>
    </div>
  );
}

/**
 * Administration → Audit sinks. Where the immutable audit log is also
 * copied — a SIEM webhook, an object storage bucket, a syslog collector, or
 * a periodic email digest. Any number can run at once, each with its own
 * filter, delivery state and failure history.
 */
export default function AuditSinksTab() {
  const [sinks, setSinks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [flash, setFlash] = useState(null);

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [deliveriesFor, setDeliveriesFor] = useState(null);
  const [confirm, setConfirm] = useState(null); // { kind: 'delete' | 'disable', sink }
  const [testingId, setTestingId] = useState(null);

  const refresh = useCallback(() => {
    setLoading(true);
    return listAuditSinks()
      .then((list) => {
        setSinks(list || []);
        setError('');
      })
      .catch((err) => setError(err?.response?.data?.error?.message || err.message || 'Failed to load audit sinks'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const runAction = async (fn, successMessage) => {
    setError('');
    try {
      await fn();
      if (successMessage) setFlash({ tone: 'success', message: successMessage });
      await refresh();
    } catch (err) {
      setError(err?.response?.data?.error?.message || err.message || 'Action failed');
    }
  };

  const handleConfirm = async () => {
    const { kind, sink } = confirm || {};
    setConfirm(null);
    if (kind === 'delete') {
      await runAction(() => deleteAuditSink(sink.id), `Deleted ${sink.name}.`);
    } else if (kind === 'disable') {
      await runAction(() => updateAuditSink(sink.id, { isActive: false }), `${sink.name} disabled — delivery stops immediately.`);
    }
  };

  const handleToggleActive = (sink) => {
    if (sink.isActive) {
      setConfirm({ kind: 'disable', sink });
    } else {
      runAction(() => updateAuditSink(sink.id, { isActive: true }), `${sink.name} enabled.`);
    }
  };

  const handleTest = async (sink) => {
    setTestingId(sink.id);
    setError('');
    try {
      const result = await testAuditSink(sink.id);
      setFlash({
        tone: result.ok ? 'success' : 'danger',
        message: result.ok ? result.detail || `${sink.name}: test passed.` : result.error || `${sink.name}: test failed.`,
      });
    } catch (err) {
      setError(err?.response?.data?.error?.message || err.message || 'Test failed');
    } finally {
      setTestingId(null);
      refresh();
    }
  };

  const confirmCopy = (() => {
    if (!confirm) return {};
    const { kind, sink } = confirm;
    if (kind === 'delete') {
      return {
        title: `Delete ${sink.name}?`,
        message: 'Its delivery history and saved position are removed. This cannot be undone.',
        confirmLabel: 'Delete',
        variant: 'destructive',
      };
    }
    return {
      title: `Disable ${sink.name}?`,
      message: sink.streaming
        ? 'Delivery stops immediately. Turning it back on resumes from its saved position — nothing that happens while it is off is skipped, just delayed.'
        : 'The scheduled digest stops immediately. Turning it back on resumes on its normal schedule.',
      confirmLabel: 'Disable',
      variant: 'destructive',
    };
  })();

  return (
    <SectionCard
      title="Audit sinks"
      description="Copy the audit log to a SIEM, a bucket or a periodic digest email your security team already watches."
      actions={
        <Button
          size="sm"
          onClick={() => {
            setEditing(null);
            setFormOpen(true);
          }}
        >
          <Plus className="mr-1.5 h-4 w-4" />
          Add sink
        </Button>
      }
    >
      <div className="space-y-4">
        {flash && (
          <Notice tone={flash.tone} icon={flash.tone === 'success' ? CheckCircle2 : AlertTriangle}>
            {flash.message}
          </Notice>
        )}
        {error && (
          <Notice tone="danger" icon={AlertTriangle}>
            {error}
          </Notice>
        )}

        {loading ? (
          <div className="space-y-2 py-2">
            {[1, 2].map((i) => (
              <div key={i} className="h-32 animate-pulse rounded-lg bg-muted" />
            ))}
          </div>
        ) : sinks.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border px-6 py-10 text-center">
            <ScrollText className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
            <p className="text-sm font-medium text-foreground">No audit sinks yet</p>
            <p className="max-w-md text-xs text-muted-foreground">
              Add a webhook, object storage, syslog or email digest sink to copy the audit log elsewhere.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {sinks.map((s) => (
              <SinkCard
                key={s.id}
                sink={s}
                testingId={testingId}
                onEdit={(sk) => {
                  setEditing(sk);
                  setFormOpen(true);
                }}
                onDelete={(sk) => setConfirm({ kind: 'delete', sink: sk })}
                onToggleActive={handleToggleActive}
                onTest={handleTest}
                onDeliveries={setDeliveriesFor}
              />
            ))}
          </div>
        )}
      </div>

      <AuditSinkFormModal
        open={formOpen}
        onClose={() => setFormOpen(false)}
        sink={editing}
        onSaved={(saved) => {
          setFormOpen(false);
          setFlash({ tone: 'success', message: editing ? `Saved ${saved?.name || 'sink'}.` : `Added ${saved?.name || 'sink'}.` });
          refresh();
        }}
      />

      <AuditSinkDeliveriesModal open={!!deliveriesFor} onClose={() => setDeliveriesFor(null)} sink={deliveriesFor} />

      <ConfirmDialog
        open={!!confirm}
        title={confirmCopy.title}
        message={confirmCopy.message}
        confirmLabel={confirmCopy.confirmLabel}
        variant={confirmCopy.variant}
        onConfirm={handleConfirm}
        onCancel={() => setConfirm(null)}
      />
    </SectionCard>
  );
}
