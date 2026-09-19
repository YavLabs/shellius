import { Link, Outlet, useLocation } from 'react-router-dom';
import { ShieldOff } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import { canAccessRoute } from '@/lib/commands';

/**
 * Route guard driven by ROUTE_ACCESS (lib/commands.js) — the same table the
 * Sidebar, command palette and shortcuts use. Blocks direct-URL access to a
 * page the user's role can't open and says so, instead of silently bouncing
 * them to the dashboard (deep links from emails used to look broken).
 */
function PermissionRoute() {
  const { user, loading } = useAuth();
  const { pathname } = useLocation();
  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="text-muted-foreground">Loading...</div>
      </div>
    );
  }
  if (!canAccessRoute(user, pathname)) {
    return (
      <div className="mx-auto flex max-w-md flex-col items-center py-24 text-center">
        <span className="flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <ShieldOff className="h-6 w-6" />
        </span>
        <h1 className="mt-4 text-lg font-semibold text-foreground">You don’t have access to this page</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Your role doesn’t include the permission this page needs. Ask an administrator if you think it should.
        </p>
        <Link to="/" className="mt-5 text-sm font-medium text-primary hover:underline">
          Back to dashboard
        </Link>
      </div>
    );
  }
  return <Outlet />;
}

export default PermissionRoute;
