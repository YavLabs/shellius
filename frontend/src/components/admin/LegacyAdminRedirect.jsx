import { Navigate, useLocation } from 'react-router-dom';
import { legacyAdminPath } from '@/lib/adminSections';

/**
 * Keeps old bookmarks and links working: /settings(?tab=…), /users, /roles,
 * /roles/:id, /groups and /groups/:id redirect into Administration (which
 * then applies its own permission checks). Other query params are kept.
 */
function LegacyAdminRedirect() {
  const { pathname, search, hash } = useLocation();
  const to = legacyAdminPath(pathname, search) || '/admin';
  return <Navigate to={`${to}${hash || ''}`} replace />;
}

export default LegacyAdminRedirect;
