import { useEffect, useState } from 'react';
import { AlertTriangle, Check, Copy } from 'lucide-react';
import Modal from '@/components/shared/Modal';
import { Button } from '@/components/ui/button';

/**
 * TokenRevealDialog — the ONE moment a personal access token or service
 * account token's plaintext value is ever shown, right after create/rotate.
 * Nothing else in the app renders a token value again: list views only ever
 * carry `tokenPrefix` (e.g. "shp_a1b2c3d4"), which can't authenticate.
 *
 * This is deliberately impossible to miss — a full-width monospace block,
 * an unmissable "won't be shown again" warning, and a copy button with an
 * explicit copied-confirmation. `onClose` should throw the plaintext value
 * away; the caller must not stash it in state that outlives this dialog.
 *
 * Props:
 *   open       {boolean}
 *   onClose    () => void
 *   token      {string}   the plaintext bearer token (e.g. "shp_…" / "shs_…")
 *   name       {string}   the token's display name, for the title
 *   subtitle?  {string}   e.g. "Rotated — the previous value stopped working."
 */
export default function TokenRevealDialog({ open, onClose, token, name, subtitle }) {
  const [copied, setCopied] = useState(false);

  // Reset the "copied" confirmation each time a new token is shown.
  useEffect(() => {
    if (open) setCopied(false);
  }, [open, token]);

  if (!open) return null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(token || '');
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* ignore — the value is still selectable in the code block */
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={name ? `${name} — token created` : 'Token created'} size="lg">
      <div className="space-y-4">
        <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <div>
            <p className="font-medium">This is the only time this token will be shown.</p>
            <p className="mt-0.5 text-xs">
              Copy it now and store it somewhere safe. Shellius does not keep the plaintext value — if you lose it,
              you&apos;ll need to rotate or create a new one.
            </p>
            {subtitle && <p className="mt-1 text-xs">{subtitle}</p>}
          </div>
        </div>

        <div>
          <label className="mb-1.5 block text-sm font-medium text-foreground">Token</label>
          <div className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2.5">
            <code className="min-w-0 flex-1 select-all break-all font-mono text-sm text-foreground">{token}</code>
            <Button type="button" size="sm" variant={copied ? 'secondary' : 'outline'} onClick={copy} className="shrink-0">
              {copied ? <Check className="mr-1.5 h-3.5 w-3.5" /> : <Copy className="mr-1.5 h-3.5 w-3.5" />}
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
        </div>

        <div>
          <label className="mb-1.5 block text-sm font-medium text-foreground">Usage</label>
          <div className="rounded-md border border-border bg-muted/40 px-3 py-2">
            <code className="break-all font-mono text-xs text-muted-foreground">Authorization: Bearer {token}</code>
          </div>
        </div>

        <div className="flex justify-end pt-1">
          <Button type="button" onClick={onClose}>
            Done — I&apos;ve saved it
          </Button>
        </div>
      </div>
    </Modal>
  );
}
