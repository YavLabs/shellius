import { ShieldCheck } from 'lucide-react';
import { canMarkExpected } from '@/lib/postureLabels';

/**
 * Marks a finding row that "Mark expected" can actually resolve.
 *
 * Mute and Acknowledge apply to every finding; declaring a port expected
 * only resolves the three exposure codes (see EXPECTED_PORT_RESOLVES). The
 * bulk bar already refuses to act on the rest and says how many it skipped —
 * but only after you have selected them, which makes a correct refusal feel
 * like a bug you caused. This says which rows qualify before you choose.
 *
 * Deliberately a marker on the eligible rows rather than a warning on the
 * others: most selections are exposure findings, so flagging the exception
 * would put a warning icon on the common case.
 */
function ExpectableMarker({ finding, className = '' }) {
  if (!canMarkExpected(finding)) return null;
  return (
    <ShieldCheck
      className={`inline h-3.5 w-3.5 shrink-0 text-emerald-600/70 dark:text-emerald-400/70 ${className}`}
      aria-label="Can be marked expected"
      title={`Bulk action available: marking ${finding.proto}/${finding.port} expected on this server resolves this finding. Mute and Acknowledge apply to every finding.`}
    />
  );
}

export default ExpectableMarker;
