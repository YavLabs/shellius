import { useEffect, useState } from 'react';
import { CheckCircle2, XCircle } from 'lucide-react';
import Modal from '@/components/shared/Modal';
import { Button } from '@/components/ui/button';
import { testEmailProvider } from '@/services/emailProviderService';

const inputCls =
  'h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring';

/**
 * "Send test email" — sends a real email through one provider (active or
 * not) and shows the provider's own error text on failure.
 *
 * Props: open, onClose, provider, defaultTo, onTested(updatedProvider)
 */
export default function TestEmailModal({ open, onClose, provider, defaultTo, onTested }) {
  const [to, setTo] = useState('');
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState(null);

  useEffect(() => {
    if (!open) return;
    setTo(defaultTo || '');
    setResult(null);
    setSending(false);
  }, [open, defaultTo]);

  const handleSend = async (e) => {
    e?.preventDefault();
    setSending(true);
    setResult(null);
    try {
      const r = await testEmailProvider(provider.id, to.trim());
      setResult(r.ok ? { ok: true, message: `Test email sent to ${r.sentTo}. Check the inbox (and spam folder).` } : { ok: false, message: r.error });
      if (r.provider) onTested?.(r.provider);
    } catch (err) {
      setResult({ ok: false, message: err?.response?.data?.error?.message || err.message || 'Test failed' });
    } finally {
      setSending(false);
    }
  };

  const footer = (
    <div className="flex justify-end gap-2">
      <Button type="button" variant="outline" size="sm" onClick={onClose}>
        Close
      </Button>
      <Button type="submit" form="email-test-form" size="sm" disabled={sending || !to.trim()}>
        {sending ? 'Sending…' : 'Send test email'}
      </Button>
    </div>
  );

  return (
    <Modal open={open} onClose={onClose} title={`Send test email — ${provider?.name || ''}`} footer={footer}>
      <form id="email-test-form" onSubmit={handleSend} className="space-y-4">
        <div>
          <label htmlFor="email-test-to" className="mb-1.5 block text-sm font-medium text-foreground">
            To
          </label>
          <input
            id="email-test-to"
            type="email"
            className={inputCls}
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder="you@example.com"
            autoFocus
          />
          <p className="mt-1 text-xs text-muted-foreground">
            Sent through <strong>{provider?.typeLabel}</strong>
            {provider?.effectiveFrom ? (
              <>
                {' '}from <code>{provider.effectiveFrom}</code>
              </>
            ) : null}
            {provider && !provider.isActive ? ' — this provider is not active, so a successful test does not change how email is sent.' : '.'}
          </p>
        </div>

        {result && (
          <div
            role="status"
            className={[
              'flex items-start gap-2 rounded-md border px-3 py-2 text-sm',
              result.ok
                ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                : 'border-destructive/50 bg-destructive/10 text-destructive',
            ].join(' ')}
          >
            {result.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : <XCircle className="mt-0.5 h-4 w-4 shrink-0" />}
            <span className="break-words">
              {result.ok ? result.message : (
                <>
                  <strong>Delivery failed.</strong> {result.message}
                </>
              )}
            </span>
          </div>
        )}
      </form>
    </Modal>
  );
}
