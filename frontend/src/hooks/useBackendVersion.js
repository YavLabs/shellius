import { useState, useEffect } from 'react';
import api from '@/services/api';

/**
 * Fetches the running backend's version from GET /api/health so the footer
 * can warn when the deployed frontend and backend have drifted apart (a
 * classic stale-deploy symptom). Best-effort: never throws, returns null on
 * any failure so the footer just omits the mismatch warning.
 */
export default function useBackendVersion() {
  const [backendVersion, setBackendVersion] = useState(null);

  useEffect(() => {
    let cancelled = false;
    api
      .get('/health')
      .then((r) => {
        if (!cancelled) setBackendVersion(r.data?.data?.version || null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  return backendVersion;
}
