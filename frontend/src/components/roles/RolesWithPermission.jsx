import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import { listRoles } from '@/services/roleService';

/**
 * Chips for the roles that hold `permission`, each linking to the role
 * (when the viewer can open Roles). `roles` may be passed in (e.g. from the
 * access-settings API); otherwise they're fetched when the viewer may list
 * roles.
 */
function RolesWithPermission({ permission, roles: given, emptyText = 'No role has this permission.' }) {
  const { can } = useAuth();
  const canView = can('roles.view');
  const [roles, setRoles] = useState(given || null);

  useEffect(() => {
    if (given) {
      setRoles(given);
      return;
    }
    if (!canView) return;
    listRoles()
      .then((all) => setRoles(all.filter((r) => r.permissions.includes(permission))))
      .catch(() => setRoles([]));
  }, [given, canView, permission]);

  if (!roles) return null;
  if (roles.length === 0) return <p className="text-xs text-muted-foreground">{emptyText}</p>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {roles.map((r) =>
        canView ? (
          <Link
            key={r.id}
            to={`/admin/roles/${r.id}`}
            className="inline-flex h-6 items-center rounded-full border border-border bg-muted/40 px-2.5 text-xs font-medium text-foreground hover:border-primary/40 hover:bg-accent"
          >
            {r.name}
          </Link>
        ) : (
          <span
            key={r.id}
            className="inline-flex h-6 items-center rounded-full border border-border bg-muted/40 px-2.5 text-xs font-medium text-foreground"
          >
            {r.name}
          </span>
        )
      )}
    </div>
  );
}

export default RolesWithPermission;
