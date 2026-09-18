import { Badge } from '@/components/ui/badge';
import { certificateStatusTone } from '@/lib/badgeTones';

function CertStatusBadge({ status, className }) {
  const { tone, label } = certificateStatusTone(status);
  return (
    <Badge tone={tone} className={className}>
      {label}
    </Badge>
  );
}

export default CertStatusBadge;
