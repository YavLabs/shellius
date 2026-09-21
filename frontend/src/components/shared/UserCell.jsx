import Avatar from '@/components/ui/Avatar';
import EntityLink from '@/components/EntityLink';

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
 * Every user with an id is navigable by default — Administration has no
 * standalone user detail page, so it opens `/admin/users?highlight=<id>`
 * (same deep link Users.jsx's own row actions use). EntityLink degrades to
 * plain text on its own when the viewer lacks `users.view`, so this is safe
 * to leave on everywhere. Pass `linkable={false}` to opt out (e.g. a cell
 * that's already inside a link/button of its own), or `to` to point
 * somewhere else entirely.
 *
 * Props:
 *   user      {{ id?, name?, email?, avatarUrl? } | null | undefined}
 *   size      'sm' | 'md' (default 'sm')
 *   subtitle  optional override for the subtext line (defaults to email)
 *   to        optional route override (defaults to the admin users deep link)
 *   linkable  set false to render plain text even with an id (default true)
 *   fallback  label shown when `user` is nullish (default "System")
 *   className
 */
const AVATAR_SIZE = { sm: 'sm', md: 'md' };
const NAME_CLS = { sm: 'text-sm font-medium text-foreground', md: 'text-sm font-medium text-foreground' };
const SUB_CLS = { sm: 'text-xs text-muted-foreground', md: 'text-xs text-muted-foreground' };

function UserCell({ user, size = 'sm', subtitle, to, linkable = true, fallback = 'System', className = '' }) {
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

  const dest = to !== undefined ? to : linkable && user.id ? `/admin/users?highlight=${user.id}` : null;

  if (dest) {
    return (
      <EntityLink to={dest} entityType="user" entityName={name} icon={false}>
        {content}
      </EntityLink>
    );
  }

  return content;
}

export default UserCell;
