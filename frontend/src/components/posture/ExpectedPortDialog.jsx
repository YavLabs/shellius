import { useEffect, useState } from 'react';
import { Loader2, ShieldCheck } from 'lucide-react';
import Modal from '@/components/shared/Modal';
import { Button } from '@/components/ui/button';
import { addExpectedPorts } from '@/services/postureService';

/**
 * ExpectedPortDialog — declare that a port is meant to be public on this host.
 *
 * Deliberately per-server. The org-wide list in Administration answers "8080
 * is fine" for the whole fleet, which is the wrong granularity for the common
 * case: 8080 on a demo box is routine, 8080 on a database host is worth a
 * phone call. Doing it from the finding you are looking at also means the
 * inbox visibly shrinks — the API resolves the matching findings immediately
 * rather than waiting for the next snapshot.
 *
 * A reason is required, for the same reason muting requires one: a
 * suppression with no stated cause is indistinguishable from a mistake when
 * someone reviews it six months later.
 *
 * @param {{port: number, proto?: string}[]} targets  ports to declare
 */
function ExpectedPortDialog({ open, serverId, targets = [], skipped = 0, onClose, onDone }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setReason('');
    setError('');
    setBusy(false);
  }, [open]);

  // Two findings can name the same port (a firewall bypass and an exposure,
  // say); one declaration covers both.
  const unique = [];
  const seen = new Set();
  for (const t of targets) {
    const key = `${t.port}/${t.proto || 'any'}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push({ port: t.port, proto: t.proto || 'any' });
    }
  }

  const submit = async () => {
    if (!reason.trim() || unique.length === 0) return;
    setBusy(true);
    setError('');
    try {
      const result = await addExpectedPorts(
        serverId,
        unique.map((t) => ({ ...t, note: reason.trim() }))
      );
      // The caller closes and reports the outcome, the same way MuteDialog
      // works — a dialog that stays open after a successful save reads as a
      // save that did not happen.
      onDone?.(result);
    } catch (err) {
      setError(err?.response?.data?.error?.message || err.message || 'Could not save.');
    } finally {
      setBusy(false);
    }
  };

  const footer = (
    <div className="flex items-center justify-end gap-2" data-sheet-footer>
      <Button variant="outline" onClick={onClose} disabled={busy}>
        Cancel
      </Button>
      <Button onClick={submit} disabled={busy || !reason.trim() || unique.length === 0}>
        {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ShieldCheck className="mr-2 h-4 w-4" />}
        {busy ? 'Saving…' : 'Mark as expected'}
      </Button>
    </div>
  );

  return (
    <Modal open={open} onClose={onClose} title="Expected on this server" size="md" footer={footer}>
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          These ports will stop being reported as exposed{' '}
          <span className="font-medium text-foreground">on this server only</span>. Their open
          findings resolve now, and they will not reopen while the declaration stands.
        </p>

        {skipped > 0 && (
          <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            {skipped} of the findings you selected {skipped === 1 ? 'is' : 'are'} not a port
            exposure — a firewall finding, or a port already expected — so marking a port expected
            cannot resolve {skipped === 1 ? 'it' : 'them'}. {skipped === 1 ? 'It stays' : 'They stay'} open.
          </p>
        )}

        <div className="rounded-lg border border-border">
          <p className="border-b border-border px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">
            {unique.length} port{unique.length === 1 ? '' : 's'}
          </p>
          <ul className="max-h-40 divide-y divide-border overflow-y-auto">
            {unique.map((t) => (
              <li key={`${t.port}/${t.proto}`} className="px-3 py-2 font-mono text-sm text-foreground">
                {t.proto === 'any' ? 'any' : t.proto.toUpperCase()}/{t.port}
              </li>
            ))}
          </ul>
        </div>

        <label className="block">
          <span className="text-sm font-medium text-foreground">
            Why is this expected? <span className="text-destructive">*</span>
          </span>
          <textarea
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Public demo frontend behind Cloudflare"
            className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <span className="mt-1 block text-xs text-muted-foreground">
            Recorded against the entry and shown to whoever reviews this later.
          </span>
        </label>

        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}

export default ExpectedPortDialog;
