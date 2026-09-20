import { Badge } from '@/components/ui/badge';
import { findingStatusTone } from '@/lib/badgeTones';

function FindingStatusBadge({ status, className }) {
  const { tone, label } = findingStatusTone(status);
  return (
    <Badge tone={tone} className={className}>
      {label}
    </Badge>
  );
}

export default FindingStatusBadge;
