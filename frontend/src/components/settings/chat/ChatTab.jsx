import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, History, Info, MessageSquareOff, Pencil, Play, Plus, Send, Trash2, Zap } from 'lucide-react';
import { SectionCard } from '@/components/settings/shared';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import ConfirmDialog from '@/components/shared/ConfirmDialog';
import { relativeTime, formatDateTime } from '@/utils/time';
import {
  listChatDestinations,
  deleteChatDestination,
  updateChatDestination,
  testChatDestination,
  listChatEvents,
} from '@/services/chatDestinationService';
import { variantFor, chatDestinationStatus, customerScopeSummary, eventsSummary } from './chatTypes';
import ChatDestinationFormModal from './ChatDestinationFormModal';
import ChatDeliveriesModal from './ChatDeliveriesModal';

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

function TestStatus({ destination }) {
  if (!destination.lastTestAt) return <span className="text-xs text-muted-foreground">Not tested yet</span>;
  if (destination.lastTestOk) {
    return (
      <Badge tone="success" dot title={formatDateTime(destination.lastTestAt)}>
        Test passed · {relativeTime(destination.lastTestAt)}
      </Badge>
    );
  }
  return (
    <div className="min-w-0 space-y-1">
      <Badge tone="danger" dot title={formatDateTime(destination.lastTestAt)}>
        Test failed · {relativeTime(destination.lastTestAt)}
      </Badge>
      {destination.lastTestError && <p className="break-words text-xs text-destructive">{destination.lastTestError}</p>}
    </div>
  );
}

function DestinationCard({ destination, eventCatalogue, onEdit, onDelete, onToggleActive, onTest, onDeliveries, testingId }) {
  const variant = variantFor(destination.platform, destination.mode);
  const Icon = variant?.icon || MessageSquareOff;
  const status = chatDestinationStatus(destination);
  const testing = testingId === destination.id;
  const evSummary = eventsSummary(destination.events, eventCatalogue);
  const custSummary = customerScopeSummary(destination.customerIds);

  return (
    <div
      className={[
        'rounded-lg border bg-card p-4',
        destination.disabledReason ? 'border-destructive/40' : destination.isActive ? 'border-border' : 'border-border opacity-80',
      ].join(' ')}
    >
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border bg-muted/40">
          <Icon className="h-4 w-4 text-foreground" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="truncate text-sm font-semibold text-foreground">{destination.name}</p>
            <Badge tone="neutral" variant="outline">
              {destination.platformLabel || variant?.label || destination.platform}
            </Badge>
            <Badge tone={status.tone} dot>
              {status.label}
            </Badge>
            {destination.canAct && (
              <Badge tone="accent" variant="outline">
                Buttons + DMs
              </Badge>
            )}
          </div>

          {destination.target && <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">{destination.target}</p>}

          <p className="mt-1.5 text-xs text-muted-foreground">{evSummary.text}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{custSummary}</p>

          {destination.disabledReason && (
            <p className="mt-1.5 flex items-start gap-1.5 text-xs font-medium text-destructive">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              {destination.disabledReason}
            </p>
          )}

          <p className="mt-1.5 text-xs text-muted-foreground">
            {destination.lastDeliveredAt ? `Last delivered ${relativeTime(destination.lastDeliveredAt)}` : 'Nothing delivered yet'}
            {destination.lastError && !destination.disabledReason ? ` — retrying: ${destination.lastError}` : ''}
            {destination.consecutiveFailures > 0 && !destination.disabledReason
              ? ` · ${destination.consecutiveFailures} consecutive failure${destination.consecutiveFailures === 1 ? '' : 's'}`
              : ''}
            {destination.backoffUntil && !destination.disabledReason
              ? ` · backing off until ${formatDateTime(destination.backoffUntil)}`
              : ''}
          </p>

          <div className="mt-2">
            <TestStatus destination={destination} />
          </div>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-2 border-t border-border pt-3">
        <Button size="sm" variant="outline" onClick={() => onTest(destination)} disabled={testing}>
          <Send className="mr-1.5 h-3.5 w-3.5" />
          {testing ? 'Testing…' : 'Test'}
        </Button>
        <Button size="sm" variant="outline" onClick={() => onDeliveries(destination)}>
          <History className="mr-1.5 h-3.5 w-3.5" />
          Recent deliveries
        </Button>
        <Button size="sm" variant="ghost" onClick={() => onEdit(destination)}>
          <Pencil className="mr-1.5 h-3.5 w-3.5" />
          Edit
        </Button>
        <Button size="sm" variant="ghost" onClick={() => onToggleActive(destination)}>
          {destination.isActive ? (
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
        <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => onDelete(destination)}>
          <Trash2 className="mr-1.5 h-3.5 w-3.5" />
          Delete
        </Button>
      </div>
    </div>
  );
}

/**
 * Administration → Chat notifications. Where events (an access request
 * needing review, break-glass, a posture finding) are posted to Slack,
 * Google Chat, Microsoft Teams or a plain webhook — the direct sibling of
 * Audit sinks (../auditSinks/AuditSinksTab.jsx), same shape: write-only
 * secrets, a test button, a deliveries log, auto-disable after repeated
 * failure.
 *
 * Two things read differently from every other destination-list here on
 * purpose: only a Slack app (bot token) can carry an approve/deny button or
 * send a direct message — Google Chat and Teams are one-way by platform
 * design, not a missing feature — and customer scope is deny-by-default: an
 * empty customer list sends only events tied to no customer, not everything.
 */
export default function ChatTab() {
  const [destinations, setDestinations] = useState([]);
  const [eventCatalogue, setEventCatalogue] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [flash, setFlash] = useState(null);

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [deliveriesFor, setDeliveriesFor] = useState(null);
  const [confirm, setConfirm] = useState(null); // { kind: 'delete' | 'disable', destination }
  const [testingId, setTestingId] = useState(null);

  const refresh = useCallback(() => {
    setLoading(true);
    return Promise.all([listChatDestinations(), listChatEvents().catch(() => [])])
      .then(([list, events]) => {
        setDestinations(list || []);
        setEventCatalogue(events || []);
        setError('');
      })
      .catch((err) => setError(err?.response?.data?.error?.message || err.message || 'Failed to load chat destinations'))
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
    const { kind, destination } = confirm || {};
    setConfirm(null);
    if (kind === 'delete') {
      await runAction(() => deleteChatDestination(destination.id), `Deleted ${destination.name}.`);
    } else if (kind === 'disable') {
      await runAction(() => updateChatDestination(destination.id, { isActive: false }), `${destination.name} disabled — delivery stops immediately.`);
    }
  };

  const handleToggleActive = (destination) => {
    if (destination.isActive) {
      setConfirm({ kind: 'disable', destination });
    } else {
      runAction(() => updateChatDestination(destination.id, { isActive: true }), `${destination.name} enabled.`);
    }
  };

  const handleTest = async (destination) => {
    setTestingId(destination.id);
    setError('');
    try {
      const result = await testChatDestination(destination.id);
      setFlash({
        tone: result.ok ? 'success' : 'danger',
        message: result.ok ? result.detail || `${destination.name}: test passed.` : result.error || `${destination.name}: test failed.`,
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
    const { kind, destination } = confirm;
    if (kind === 'delete') {
      return {
        title: `Delete ${destination.name}?`,
        message: 'Its delivery history is removed. This cannot be undone.',
        confirmLabel: 'Delete',
        variant: 'destructive',
      };
    }
    return {
      title: `Disable ${destination.name}?`,
      message: 'Delivery stops immediately. Turning it back on resumes normally — nothing that happened while it was off is replayed.',
      confirmLabel: 'Disable',
      variant: 'destructive',
    };
  })();

  return (
    <SectionCard
      title="Chat notifications"
      description="Post access requests, break-glass and posture findings to Slack, Google Chat, Microsoft Teams or a webhook."
      actions={
        <Button
          size="sm"
          onClick={() => {
            setEditing(null);
            setFormOpen(true);
          }}
        >
          <Plus className="mr-1.5 h-4 w-4" />
          Add destination
        </Button>
      }
    >
      <div className="space-y-4">
        <Notice tone="info">
          Only a Slack app (bot token) can carry approve/deny buttons or send a direct message. Google Chat and Microsoft Teams
          webhooks are one-way by platform design — they post, and that is not a missing feature.
        </Notice>

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
        ) : destinations.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border px-6 py-10 text-center">
            <MessageSquareOff className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
            <p className="text-sm font-medium text-foreground">No chat destinations yet</p>
            <p className="max-w-md text-xs text-muted-foreground">
              Add Slack, Google Chat, Microsoft Teams or a webhook so people hear about requests, break-glass and findings where
              they already work.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {destinations.map((d) => (
              <DestinationCard
                key={d.id}
                destination={d}
                eventCatalogue={eventCatalogue}
                testingId={testingId}
                onEdit={(dest) => {
                  setEditing(dest);
                  setFormOpen(true);
                }}
                onDelete={(dest) => setConfirm({ kind: 'delete', destination: dest })}
                onToggleActive={handleToggleActive}
                onTest={handleTest}
                onDeliveries={setDeliveriesFor}
              />
            ))}
          </div>
        )}
      </div>

      <ChatDestinationFormModal
        open={formOpen}
        onClose={() => setFormOpen(false)}
        destination={editing}
        onSaved={(saved) => {
          setFormOpen(false);
          setFlash({ tone: 'success', message: editing ? `Saved ${saved?.name || 'destination'}.` : `Added ${saved?.name || 'destination'}.` });
          refresh();
        }}
      />

      <ChatDeliveriesModal open={!!deliveriesFor} onClose={() => setDeliveriesFor(null)} destination={deliveriesFor} />

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
