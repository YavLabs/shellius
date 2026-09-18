import { Badge } from '@/components/ui/badge';
import { environmentTone } from '@/lib/badgeTones';

function EnvironmentBadge({ environment, className }) {
  if (!environment) return null;
  const { tone, label } = environmentTone(environment);
  return (
    <Badge tone={tone} uppercase className={className}>
      {label}
    </Badge>
  );
}

export default EnvironmentBadge;
