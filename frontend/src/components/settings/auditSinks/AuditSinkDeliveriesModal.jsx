import { useCallback, useEffect, useState } from 'react';
import { Info, PackageOpen } from 'lucide-react';
import Modal from '@/components/shared/Modal';
import { Badge } from '@/components/ui/badge';
import { listAuditSinkDeliveries } from '@/services/auditSinkService';
import { formatDateTime, relativeTime } from '@/utils/time';
import { deliveryStatusBadge } from './sinkTypes';

function DeliveryRow({ delivery }) {
  const badge = deliveryStatusBadge(delivery.status);
  return (
    <div className="rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={badge.tone}>{badge.label}</Badge>
        <span className="font-mono text-xs text-muted-foreground">{delivery.batchId}</span>
        {delivery.attempt > 1 && (
          <span className="text-xs text-muted-foreground">attempt {delivery.attempt}</span>
        )}
        <span className="ml-auto text-xs text-muted-foreground" title={formatDateTime(delivery.startedAt)}>
          {relativeTime(delivery.startedAt || delivery.finishedAt)}
        </span>
      </div>
      <p className="mt-1.5 text-xs text-muted-foreground">
        {delivery.count} {delivery.count === 1 ? 'entry' : 'entries'} · {formatDateTime(delivery.fromCreatedAt)} –{' '}
        {formatDateTime(delivery.toCreatedAt)}
        {Number.isFinite(delivery.durationMs) ? ` · ${delivery.durationMs.toLocaleString()} ms` : ''}
      </p>
      {delivery.objectKey && (
        <p className="mt-1 break-all font-mono text-xs text-muted-foreground">{delivery.objectKey}</p>
      )}
      {delivery.error && <p className="mt-1 break-words text-xs text-destructive">{delivery.error}</p>}
    </div>
  );
}

/**
 * Recent deliveries for one sink (GET /settings/audit-sinks/:id/deliveries).
 * Delivery is at-least-once — the same batchId can legitimately appear twice
 * after a retry, which is why every batch carries a stable id: a receiver
 * dedupes on it rather than assuming one delivery per batch.
 *
 * Props: open, onClose, sink
 */
export default function AuditSinkDeliveriesModal({ open, onClose, sink }) {
  const [deliveries, setDeliveries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const refresh = useCallback(() => {
    if (!sink?.id) return Promise.resolve();
    setLoading(true);
    return listAuditSinkDeliveries(sink.id, 20)
      .then((list) => {
        setDeliveries(list || []);
        setError('');
      })
      .catch((err) => setError(err.response?.data?.error?.message || err.message || 'Failed to load deliveries.'))
      .finally(() => setLoading(false));
  }, [sink?.id]);

  useEffect(() => {
    if (open) refresh();
  }, [open, refresh]);

  if (!open) return null;

  return (
    <Modal open={open} onClose={onClose} title={`Recent deliveries — ${sink?.name || ''}`} size="lg">
      <div className="space-y-4">
        <div className="flex items-start gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>
            Delivery is at-least-once: a retry can ship the same batch twice. Every record carries a stable id, and
            every batch a stable id shown here, so a receiver can dedupe.
          </span>
        </div>

        {error && (
          <div role="alert" className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        {loading ? (
          <div className="space-y-2">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-16 animate-pulse rounded-lg bg-muted" />
            ))}
          </div>
        ) : deliveries.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border px-6 py-8 text-center">
            <PackageOpen className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
            <p className="text-sm text-muted-foreground">Nothing delivered yet.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {deliveries.map((d) => (
              <DeliveryRow key={d.id} delivery={d} />
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}
