import { Badge } from '@/components/ui/badge';
import { authTypeTone } from '@/lib/badgeTones';

function AuthTypeBadge({ authType, className }) {
  const { tone, label } = authTypeTone(authType);
  return (
    <Badge tone={tone} className={className}>
      {label}
    </Badge>
  );
}

export default AuthTypeBadge;
