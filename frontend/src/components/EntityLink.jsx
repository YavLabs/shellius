import { Link } from 'react-router-dom';
import { ArrowUpRight } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import { canAccessRoute } from '@/lib/commands';
import { cn } from '@/lib/utils';

/**
 * EntityLink — the single "reference to another entity" used across every
 * table/card/detail view that names a server, customer, user, access
 * request, session, certificate, Keystore item, policy, role, group, cloud
 * connector or posture finding (see Servers.jsx, CustomerDetail.jsx,
 * AccessRequests.jsx for the visual language this follows).
 *
 * It renders a react-router Link that looks like a link on hover/focus
 * (underline + accent colour, a small ArrowUpRight affordance) and is
 * keyboard-focusable with a visible focus ring. It DEGRADES TO PLAIN TEXT
 * — same content, no interactive styling — when there's nothing to link to
 * (`to` missing, e.g. the entity was deleted) or when the signed-in user
 * can't open the destination page (checked via the same ROUTE_ACCESS table
 * the router/sidebar use, so a link and the page it points to never
 * disagree about who may see it).
 *
 * Safe to nest inside a clickable table row / card: clicking it stops the
 * click from bubbling to the row's own onClick.
 *
 * Props:
 *   to        route to open, or falsy to force plain text (missing id)
 *   children  the label content (text or nodes)
 *   entityType   e.g. 'server', 'customer' — used to build the default
 *                aria-label/title ("Open server Foo") when not overridden
 *   entityName   the entity's display name, for the default aria-label
 *   title     explicit title/aria-label override
 *   icon      show the hover ArrowUpRight affordance (default true)
 *   className extra classes for the link/span
 *   onClick   called after stopPropagation, before navigating
 */
function EntityLink({
  to,
  children,
  entityType,
  entityName,
  title,
  icon = true,
  className = '',
  onClick,
  ...rest
}) {
  const { user } = useAuth();
  const accessible = !!to && canAccessRoute(user, to);

  if (!accessible) {
    return (
      <span className={cn('inline-flex min-w-0 items-center gap-1', className)} {...rest}>
        {children}
      </span>
    );
  }

  const label =
    title || (entityType ? `Open ${entityType}${entityName ? ` ${entityName}` : ''}` : undefined);

  return (
    <Link
      to={to}
      title={label}
      aria-label={label}
      onClick={(e) => {
        // Never let a link inside a clickable row/card also trigger the
        // row's own navigation/onClick.
        e.stopPropagation();
        onClick?.(e);
      }}
      className={cn(
        'group inline-flex min-w-0 items-center gap-1 rounded-sm text-foreground underline-offset-2',
        'hover:text-primary hover:underline',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        className
      )}
      {...rest}
    >
      {children}
      {icon && (
        <ArrowUpRight
          className="h-3 w-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
          aria-hidden="true"
        />
      )}
    </Link>
  );
}

export default EntityLink;
