import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, Radar, ShieldCheck, Terminal, Wand2 } from 'lucide-react';
import Modal from '@/components/shared/Modal';
import { cn } from '@/lib/utils';

/**
 * BootstrapWizard — the single way into installing anything on a host.
 *
 * Step 1  Method   — manual (copy a command) or automatic (Shellius SSHes in)
 * Step 2  Scope    — SSH only / SSH + posture collector / collector only
 * Step 3+ Hand-off — manual opens BootstrapModal with the chosen scope;
 *                    automatic opens ProvisionModal, whose own form is the
 *                    credentials step and whose live output is the result.
 *
 * The wizard deliberately does NOT reimplement the credential form or the
 * command view — both already exist and are used from other entry points, so
 * forking them would mean two places to fix every future change.
 */

const METHODS = [
  {
    key: 'auto',
    icon: Wand2,
    title: 'Automatic',
    blurb: 'Shellius connects over SSH and runs the installer for you, streaming the output live.',
    needs: 'Needs credentials that can already reach the host.',
  },
  {
    key: 'manual',
    icon: Terminal,
    title: 'Manual',
    blurb: 'Get a one-line command to run on the host yourself.',
    needs: 'Nothing to configure here — works when Shellius cannot reach the host.',
  },
];

const SCOPES = [
  {
    key: 'full',
    icon: ShieldCheck,
    title: 'SSH bootstrap + posture collector',
    blurb: 'Certificate auth, check-principals, CA trust and JIT, plus exposure collection.',
  },
  {
    key: 'ssh',
    icon: Terminal,
    title: 'SSH bootstrap only',
    blurb: 'Certificate-based access with no posture collection on this host.',
  },
  {
    key: 'posture',
    icon: Radar,
    title: 'Posture collector only',
    blurb: 'Exposure collection alone. Changes nothing about how SSH authentication works.',
  },
];

/** Certificate hosts default to the full install; credential hosts to collector-only. */
export function defaultScopeFor(server) {
  return server?.authMode === 'credential' ? 'posture' : 'full';
}

function Choice({ icon: Icon, title, blurb, note, selected, onSelect }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors',
        selected
          ? 'border-primary bg-primary/5'
          : 'border-border hover:border-primary/40 hover:bg-accent/40'
      )}
    >
      <span
        className={cn(
          'mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md border',
          selected ? 'border-primary/40 bg-primary/10 text-primary' : 'border-border text-muted-foreground'
        )}
      >
        <Icon className="h-4 w-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="text-sm font-medium text-foreground">{title}</span>
          {selected && <Check className="h-3.5 w-3.5 text-primary" />}
        </span>
        <span className="mt-0.5 block text-xs text-muted-foreground">{blurb}</span>
        {note && <span className="mt-1 block text-xs text-amber-700 dark:text-amber-400">{note}</span>}
      </span>
    </button>
  );
}

function StepDots({ step, total }) {
  return (
    <div className="flex items-center gap-1.5" aria-label={`Step ${step} of ${total}`}>
      {Array.from({ length: total }, (_, i) => (
        <span
          key={i}
          className={cn('h-1.5 rounded-full transition-all', i + 1 === step ? 'w-6 bg-primary' : 'w-1.5 bg-border')}
        />
      ))}
    </div>
  );
}

/**
 * @param {object} props
 * @param {boolean} props.open
 * @param {object} props.server
 * @param {(choice: {method: 'auto'|'manual', scope: 'full'|'ssh'|'posture'}) => void} props.onStart
 *   Called when the user finishes the choices — the caller opens the matching
 *   modal (BootstrapModal for manual, ProvisionModal for automatic).
 * @param {() => void} props.onClose
 * @param {'full'|'ssh'|'posture'} [props.initialScope] - preselect (e.g. the
 *   Posture page opens this already pointed at collector-only).
 */
function BootstrapWizard({ open, server, onStart, onClose, initialScope }) {
  const [step, setStep] = useState(1);
  const [method, setMethod] = useState('auto');
  const [scope, setScope] = useState(initialScope || defaultScopeFor(server));

  // Reset per opening so a previous run's choices never leak into the next.
  useEffect(() => {
    if (!open) return;
    setStep(1);
    setMethod('auto');
    setScope(initialScope || defaultScopeFor(server));
  }, [open, server?.id, server?.authMode, initialScope]);

  const isCredentialHost = server?.authMode === 'credential';

  const scopes = useMemo(
    () =>
      SCOPES.map((s) => ({
        ...s,
        // Reconfiguring sshd on a host that deliberately authenticates with a
        // stored identity is the surprise worth calling out before they commit.
        note:
          isCredentialHost && s.key !== 'posture'
            ? 'This host connects with a stored identity — this also reconfigures sshd for certificate auth.'
            : null,
      })),
    [isCredentialHost]
  );

  const finish = () => {
    onStart?.({ method, scope });
  };

  const footer = (
    <div className="flex items-center justify-between gap-2" data-sheet-footer>
      <button
        type="button"
        onClick={step === 1 ? onClose : () => setStep(1)}
        className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border px-3 text-sm text-foreground hover:bg-accent"
      >
        {step === 1 ? 'Cancel' : (<><ArrowLeft className="h-4 w-4" /> Back</>)}
      </button>
      <button
        type="button"
        onClick={step === 1 ? () => setStep(2) : finish}
        className="inline-flex h-9 items-center gap-1.5 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90"
      >
        {step === 1 ? (<>Next <ArrowRight className="h-4 w-4" /></>) : method === 'auto' ? 'Choose credentials' : 'Get command'}
      </button>
    </div>
  );

  return (
    <Modal open={open} onClose={onClose} title="Bootstrap host" size="lg" footer={footer}>
      <div className="space-y-5">
        <div className="flex items-center justify-between gap-3">
          <p className="min-w-0 truncate text-xs text-muted-foreground">
            {server?.displayName || server?.hostname}
          </p>
          <StepDots step={step} total={2} />
        </div>

        {step === 1 && (
          <div className="space-y-3">
            <div>
              <h3 className="text-sm font-medium text-foreground">How do you want to install?</h3>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Automatic needs credentials for the host; manual gives you a command to run there.
              </p>
            </div>
            {METHODS.map((m) => (
              <Choice
                key={m.key}
                icon={m.icon}
                title={m.title}
                blurb={m.blurb}
                note={null}
                selected={method === m.key}
                onSelect={() => setMethod(m.key)}
              />
            ))}
            <p className="text-xs text-muted-foreground">
              {METHODS.find((m) => m.key === method)?.needs}
            </p>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-3">
            <div>
              <h3 className="text-sm font-medium text-foreground">What should be installed?</h3>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Installs are idempotent — running a different one later layers on top rather than
                replacing what is already there.
              </p>
            </div>
            {scopes.map((s) => (
              <Choice
                key={s.key}
                icon={s.icon}
                title={s.title}
                blurb={s.blurb}
                note={scope === s.key ? s.note : null}
                selected={scope === s.key}
                onSelect={() => setScope(s.key)}
              />
            ))}
          </div>
        )}
      </div>

    </Modal>
  );
}

export default BootstrapWizard;
