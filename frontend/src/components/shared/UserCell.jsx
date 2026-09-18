import { Link } from 'react-router-dom';
import Avatar from '@/components/ui/Avatar';

/**
 * UserCell — the single "user" display used across every table/list that
 * shows a person (Users table, Audit Log actor, Access Requests
 * requester/reviewer, Sessions user, Group members, Certificates
 * issued-to/revoked-by, Keystore createdBy/deployedBy, Approvals, Dashboard
 * widgets, command palette results, Notifications).
 *
 * Renders an Avatar + name (+ email subtext, or a custom `subtitle`).
 * Handles missing fields gracefully — falls back to "Unknown user" / "system"
 * when there's no user at all.
 *
 * Props:
 *   user      {{ name?, email?, avatarUrl? } | null | undefined}
 *   size      'sm' | 'md' (default 'sm')
 *   subtitle  optional override for the subtext line (defaults to email)
 *   to        optional route — wraps the cell in a Link
 *   fallback  label shown when `user` is nullish (default "System")
 *   className
 */
const AVATAR_SIZE = { sm: 'sm', md: 'md' };
const NAME_CLS = { sm: 'text-sm font-medium text-foreground', md: 'text-sm font-medium text-foreground' };
const SUB_CLS = { sm: 'text-xs text-muted-foreground', md: 'text-xs text-muted-foreground' };

function UserCell({ user, size = 'sm', subtitle, to, fallback = 'System', className = '' }) {
  if (!user) {
    return (
      <span className={`flex min-w-0 items-center gap-2 ${className}`}>
        <Avatar name={fallback} size={AVATAR_SIZE[size]} />
        <span className="min-w-0 truncate text-sm italic text-muted-foreground">{fallback}</span>
      </span>
    );
  }

  const name = user.name || user.email || 'Unknown user';
  const sub = subtitle !== undefined ? subtitle : user.email;

  const content = (
    <span className={`flex min-w-0 items-center gap-2 ${className}`}>
      <Avatar name={user.name} email={user.email} avatarUrl={user.avatarUrl} size={AVATAR_SIZE[size]} />
      <span className="min-w-0 leading-tight">
        <span className={`block truncate ${NAME_CLS[size]}`}>{name}</span>
        {sub && <span className={`block truncate ${SUB_CLS[size]}`}>{sub}</span>}
      </span>
    </span>
  );

  if (to) {
    return (
      <Link to={to} className="hover:underline underline-offset-2">
        {content}
      </Link>
    );
  }

  return content;
}

export default UserCell;
