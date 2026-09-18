import { Badge as UiBadge } from '@/components/ui/badge';

/**
 * shared/Badge — deprecated thin wrapper kept for backwards compatibility
 * with existing call sites (`variant="success" | "warning" | "danger" |
 * "info" | "default"`). Renders the single canonical Badge
 * (components/ui/badge.jsx) so geometry/colors stay identical everywhere.
 * New code should import { Badge } from '@/components/ui/badge' directly
 * and pass a `tone`.
 */
const VARIANT_TO_TONE = {
  default: 'neutral',
  success: 'success',
  warning: 'warning',
  danger: 'danger',
  info: 'info',
  accent: 'accent',
};

function Badge({ variant = 'default', children, className, ...props }) {
  return (
    <UiBadge tone={VARIANT_TO_TONE[variant] || 'neutral'} className={className} {...props}>
      {children}
    </UiBadge>
  );
}

export default Badge;
