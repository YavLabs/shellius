import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

const ROUTE_TITLES = {
  '/': 'Dashboard',
  '/dashboard': 'Dashboard',
  '/customers': 'Customers',
  '/servers': 'Servers',
  '/users': 'Users',
  '/groups': 'Groups',
  '/policies': 'Policies',
  '/access-requests': 'Access Requests',
  '/certificates': 'Certificates',
  '/sessions': 'Sessions',
  '/audit-log': 'Audit Log',
  '/notifications': 'Notifications',
  '/settings': 'Settings',
  '/terminal': 'Terminal',
  '/login': 'Sign in',
  '/forgot-password': 'Reset password',
};

function titleForPath(pathname) {
  if (ROUTE_TITLES[pathname]) return ROUTE_TITLES[pathname];
  // Match dynamic segments: /servers/:id → "Servers" etc.
  const root = '/' + (pathname.split('/').filter(Boolean)[0] || '');
  return ROUTE_TITLES[root] || 'Shellius';
}

export default function useDocumentTitle() {
  const { pathname } = useLocation();
  useEffect(() => {
    const t = titleForPath(pathname);
    document.title = t === 'Shellius' ? 'Shellius' : `${t} — Shellius`;
  }, [pathname]);
}
