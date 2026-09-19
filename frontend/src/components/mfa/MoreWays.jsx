import { useState } from 'react';
import { ChevronRight, KeyRound, Mail, Smartphone } from 'lucide-react';

const METHOD_INFO = {
  totp: { label: 'Authenticator app', hint: 'A code from your authenticator app', icon: Smartphone },
  email: { label: 'Email code', hint: 'We email you a one-time code', icon: Mail },
  backup: { label: 'Backup code', hint: 'One of the codes you saved', icon: KeyRound },
};

export function methodLabel(method) {
  return METHOD_INFO[method]?.label || method;
}

/**
 * "More ways to verify" — the challenge opens on the user's default factor;
 * this link lists the others (including backup codes) to switch to.
 */
export default function MoreWays({ methods = [], method, onChange }) {
  const [open, setOpen] = useState(false);
  const others = methods.filter((m) => m !== method && METHOD_INFO[m]);
  if (others.length === 0) return null;
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="text-xs text-muted-foreground hover:text-foreground">
        More ways to verify
      </button>
    );
  }
  return (
    // Full row under the other links (order-last + basis-full inside a wrapping flex row).
    <div className="order-last basis-full space-y-1.5 text-left">
      <p className="text-xs font-medium text-muted-foreground">Verify another way</p>
      <ul className="divide-y divide-border overflow-hidden rounded-md border border-border">
        {others.map((m) => {
          const { label, hint, icon: Icon } = METHOD_INFO[m];
          return (
            <li key={m}>
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  onChange(m);
                }}
                className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-accent/50"
              >
                <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm text-foreground">{label}</span>
                  <span className="block text-xs text-muted-foreground">{hint}</span>
                </span>
                <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/60" aria-hidden="true" />
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
