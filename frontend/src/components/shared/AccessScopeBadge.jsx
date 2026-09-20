import { Building2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

/**
 * AccessScopeBadge — marks a user restricted to a subset of Customers
 * (`accessScope: 'CUSTOMERS'`, docs/rbac/customer-scope-spec.md). Renders
 * nothing for unscoped ('ALL') users.
 *
 * Not to be confused with `components/shared/ScopeBadge.jsx`, which marks
 * personal-vs-organization Keystore items — a different axis entirely.
 */
function AccessScopeBadge({ accessScope, className }) {
  if (accessScope !== 'CUSTOMERS') return null;
  return (
    <Badge tone="accent" variant="outline" icon={Building2} className={className} title="Restricted to selected customers">
      Scoped
    </Badge>
  );
}

export default AccessScopeBadge;
