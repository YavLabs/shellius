import { Lock, Building2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

/**
 * ScopeBadge — marks an identity/key/host as personal ("Private", to its
 * owner only) or organization-wide. Used anywhere personal and org items can
 * appear side by side (My hosts, Quick Connect's identity picker) or where a
 * personal item needs to visibly stand out (Keystore personal-scope detail
 * modals) — see docs/personal-vault.md.
 */
function ScopeBadge({ scope, className }) {
  if (scope === 'personal') {
    return (
      <Badge tone="accent" variant="outline" icon={Lock} className={className}>
        Private
      </Badge>
    );
  }
  return (
    <Badge tone="neutral" variant="outline" icon={Building2} className={className}>
      Organization
    </Badge>
  );
}

export default ScopeBadge;
