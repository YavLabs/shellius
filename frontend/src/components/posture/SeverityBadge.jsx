import { Badge } from '@/components/ui/badge';
import { severityTone } from '@/lib/badgeTones';

/** A finding's severity, in the existing Badge tone vocabulary (lib/badgeTones.js). */
function SeverityBadge({ severity, className }) {
  const { tone, variant, label } = severityTone(severity);
  return (
    <Badge tone={tone} variant={variant} uppercase className={className}>
      {label}
    </Badge>
  );
}

export default SeverityBadge;
