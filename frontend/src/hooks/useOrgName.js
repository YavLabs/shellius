import { useState, useEffect } from 'react';
import { useAuth } from '@/context/AuthContext';
import api from '@/services/api';

const BRAND_NAME = import.meta.env.VITE_BRAND_NAME || 'Shellius';

/**
 * Resolve the operating organization's display name for copyright / branding.
 * Uses the authenticated user's org when available; otherwise falls back to the
 * public status endpoint (so public pages like Legal can still show it), then
 * the brand name.
 */
export default function useOrgName() {
  const { user } = useAuth();
  const authName = user?.organization?.name;
  const [publicName, setPublicName] = useState('');

  useEffect(() => {
    if (authName) return;
    let cancelled = false;
    api
      .get('/auth/sso/public-status')
      .then((r) => {
        if (!cancelled) setPublicName(r.data?.data?.orgName || '');
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [authName]);

  return authName || publicName || BRAND_NAME;
}
