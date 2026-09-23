import { Ban, Bell, CheckCircle, Clock, Radar, ShieldAlert, UserMinus, XCircle } from 'lucide-react';

/**
 * How each notification type looks, in one place.
 *
 * The top-bar dropdown had its own copy of this map, and the Notifications
 * page had none at all — every row there was the same blue "info" badge, so
 * an approval and a break-glass invocation looked identical. The dropdown's
 * copy had also drifted once already: its keys were short REQUEST_* spellings
 * while the enum says ACCESS_REQUEST_*, so every row fell through to the
 * generic bell. One map, read by both, is the only way the two stay agreed.
 *
 * Keys are the NotificationType enum values (backend prisma/schema.prisma).
 */
export const NOTIFICATION_META = {
  ACCESS_REQUEST_SUBMITTED: { Icon: Clock, color: 'text-amber-500', label: 'Access request submitted' },
  ACCESS_REQUEST_APPROVED: { Icon: CheckCircle, color: 'text-emerald-500', label: 'Access request approved' },
  ACCESS_REQUEST_DENIED: { Icon: XCircle, color: 'text-red-500', label: 'Access request denied' },
  ACCESS_REQUEST_EXPIRING: { Icon: Clock, color: 'text-amber-500', label: 'Access expiring' },
  ACCESS_REQUEST_EXPIRED: { Icon: Clock, color: 'text-muted-foreground', label: 'Access expired' },
  ACCESS_REQUEST_REVOKED: { Icon: Ban, color: 'text-muted-foreground', label: 'Access revoked' },
  BREAK_GLASS_INVOKED: { Icon: ShieldAlert, color: 'text-red-500', label: 'Break-glass invoked' },
  POSTURE_FINDING: { Icon: Radar, color: 'text-amber-500', label: 'Posture finding' },
  DIRECTORY_SYNC: { Icon: UserMinus, color: 'text-amber-500', label: 'Directory sync' },
};

const FALLBACK = { Icon: Bell, color: 'text-muted-foreground', label: 'Notification' };

export function notificationMeta(type) {
  return NOTIFICATION_META[type] || FALLBACK;
}
