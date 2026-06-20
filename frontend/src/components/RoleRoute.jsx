import { Navigate, Outlet } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import { roleAtLeast } from '@/lib/permissions';

/**
 * Route guard that requires a minimum role. Blocks direct-URL access to
 * admin-only areas (Users, Groups, Policies, Settings, etc.) even when the nav
 * item is hidden. Insufficient role → redirect to the dashboard.
 */
function RoleRoute({ minRole }) {
  const { user, loading } = useAuth();
  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="text-muted-foreground">Loading...</div>
      </div>
    );
  }
  if (!roleAtLeast(user, minRole)) {
    return <Navigate to="/" replace />;
  }
  return <Outlet />;
}

export default RoleRoute;
