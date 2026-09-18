import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';

function ProtectedRoute() {
  const { isAuthenticated, loading, user } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="text-muted-foreground">Loading...</div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  const onMfaSetup = location.pathname === '/mfa-setup';

  // Org enforces MFA and this user hasn't enrolled a factor yet — every other
  // page is gated behind /mfa-setup until they finish.
  if (user?.mfaSetupRequired && !onMfaSetup) {
    return <Navigate to="/mfa-setup" replace />;
  }
  // Once enrolled, the forced-setup page has nothing left to do.
  if (!user?.mfaSetupRequired && onMfaSetup) {
    return <Navigate to="/" replace />;
  }

  return <Outlet />;
}

export default ProtectedRoute;
