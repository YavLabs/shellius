import { useState } from 'react';
import { VolumeX } from 'lucide-react';
import Modal from '@/components/shared/Modal';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const PRESETS = [
  { key: '1', days: 1, label: '1 day' },
  { key: '7', days: 7, label: '7 days' },
  { key: '30', days: 30, label: '30 days' },
  { key: 'until', label: 'Until date' },
];

/**
 * Mute one or more findings — a reason is always required (spec §6 rule 2:
 * a muted finding notifies nobody, including escalations, so we make the
 * "why" explicit at the point of muting). Used for both the single-row mute
 * action and the findings inbox's bulk mute.
 */
function MuteDialog({ open, count = 1, onConfirm, onCancel, submitting = false, error }) {
  const [preset, setPreset] = useState('7');
  const [until, setUntil] = useState('');
  const [reason, setReason] = useState('');

  const reset = () => {
    setPreset('7');
    setUntil('');
    setReason('');
  };

  const close = () => {
    reset();
    onCancel?.();
  };

  const canSubmit = reason.trim().length > 0 && (preset !== 'until' || !!until) && !submitting;

  const handleSubmit = () => {
    if (!canSubmit) return;
    const payload = { reason: reason.trim() };
    if (preset === 'until') payload.until = new Date(`${until}T23:59:59`).toISOString();
    else payload.days = Number(preset);
    onConfirm?.(payload);
  };

  return (
    <Modal open={open} onClose={close} title={count > 1 ? `Mute ${count} findings` : 'Mute finding'} size="sm">
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Muted findings stop notifying — including escalations — until the mute expires or is removed. They still
          appear under the Muted tab.
        </p>

        {error && (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        <div>
          <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Mute for</label>
          <div className="flex flex-wrap gap-1.5">
            {PRESETS.map((p) => (
              <button
                key={p.key}
                type="button"
                onClick={() => setPreset(p.key)}
                className={cn(
                  'h-9 rounded-md border px-3 text-sm font-medium transition-colors',
                  preset === p.key
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-input text-muted-foreground hover:bg-accent hover:text-foreground'
                )}
              >
                {p.label}
              </button>
            ))}
          </div>
          {preset === 'until' && (
            <input
              type="date"
              value={until}
              min={new Date().toISOString().slice(0, 10)}
              onChange={(e) => setUntil(e.target.value)}
              className="mt-2 h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
          )}
        </div>

        <div>
          <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
            Reason <span className="text-destructive">*</span>
          </label>
          <textarea
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Known — firewalled behind the VPN, tracked in JIRA-1234"
          />
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="outline" onClick={close} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={!canSubmit}>
            <VolumeX className="mr-2 h-4 w-4" />
            {submitting ? 'Muting…' : count > 1 ? `Mute ${count}` : 'Mute finding'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export default MuteDialog;
