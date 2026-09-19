import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import api from '@/services/api';
import { PERMISSIONS_STALE_EVENT } from '@/lib/permissions';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [accessToken, setAccessToken] = useState(() => localStorage.getItem('accessToken'));
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);

  const loadMe = useCallback(async () => {
    const token = localStorage.getItem('accessToken');
    if (!token) {
      setIsLoading(false);
      return;
    }
    try {
      const res = await api.get('/auth/me');
      setUser(res.data?.data?.user || null);
    } catch (e) {
      localStorage.removeItem('accessToken');
      localStorage.removeItem('refreshToken');
      setAccessToken(null);
      setUser(null);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadMe();
  }, [loadMe]);

  // Permissions change without a new login (an admin edits your role), so
  // re-read /auth/me quietly: when the API says we lack a permission (the UI
  // may be stale), when the tab regains focus, and every few minutes.
  // Never logs out on failure — the api interceptor handles real 401s.
  const lastSync = useRef(0);
  const syncPermissions = useCallback(async (force = false) => {
    if (!localStorage.getItem('accessToken')) return;
    if (!force && Date.now() - lastSync.current < 30000) return;
    lastSync.current = Date.now();
    try {
      const res = await api.get('/auth/me');
      const fresh = res.data?.data?.user;
      if (fresh) setUser(fresh);
    } catch {
      /* keep what we have */
    }
  }, []);

  useEffect(() => {
    if (!user) return undefined;
    const onStale = () => syncPermissions(true);
    const onFocus = () => syncPermissions(false);
    const id = setInterval(() => syncPermissions(true), 5 * 60 * 1000);
    window.addEventListener(PERMISSIONS_STALE_EVENT, onStale);
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(id);
      window.removeEventListener(PERMISSIONS_STALE_EVENT, onStale);
      window.removeEventListener('focus', onFocus);
    };
  }, [user, syncPermissions]);

  // Permission check for components: can('servers.create').
  const can = useCallback((permission) => !!user?.permissions?.includes(permission), [user]);

  // Store a token pair + hydrate user from a login/MFA response. Returns the
  // user, or the raw challenge object when MFA is required (no tokens yet).
  const applyAuthResult = useCallback((data) => {
    if (data.mfaRequired || data.mfaSetupRequired) return data; // challenge — caller handles
    if (data.accessToken) localStorage.setItem('accessToken', data.accessToken);
    if (data.refreshToken) localStorage.setItem('refreshToken', data.refreshToken);
    setAccessToken(data.accessToken);
    setUser(data.user);
    return data.user;
  }, []);

  const login = useCallback(async (email, password) => {
    setError(null);
    try {
      const res = await api.post('/auth/login', { email, password });
      return applyAuthResult(res.data?.data || {});
    } catch (e) {
      const errBody = e.response?.data?.error;
      const code = errBody?.code;
      const msg =
        code === 'INVALID_CREDENTIALS'
          ? 'Invalid email or password'
          : errBody?.message || e.message || 'Login failed';
      setError(msg);
      const err = new Error(msg);
      err.code = code;
      err.details = errBody?.details;
      err.status = e.response?.status;
      throw err;
    }
  }, [applyAuthResult]);

  // Complete an MFA challenge from the login flow.
  const completeMfa = useCallback(async (mfaToken, method, code) => {
    setError(null);
    const res = await api.post('/auth/mfa/verify', { mfaToken, method, code });
    return applyAuthResult(res.data?.data || {});
  }, [applyAuthResult]);

  // Used by the SSO popup callback flow — tokens come from the OIDC
  // exchange, not from a username/password POST. Stores them and
  // hydrates the user via /auth/me.
  const loginWithTokens = useCallback(async ({ accessToken: at, refreshToken: rt }) => {
    setError(null);
    if (at) localStorage.setItem('accessToken', at);
    if (rt) localStorage.setItem('refreshToken', rt);
    setAccessToken(at);
    const res = await api.get('/auth/me');
    const u = res.data?.data?.user || null;
    setUser(u);
    return u;
  }, []);

  // Store a fresh token pair without an accompanying `user` payload — used
  // after changing your own password, which rotates tokens and revokes every
  // other session but doesn't re-send the user object.
  const applyTokenPair = useCallback(({ accessToken: at, refreshToken: rt }) => {
    if (at) localStorage.setItem('accessToken', at);
    if (rt) localStorage.setItem('refreshToken', rt);
    setAccessToken(at);
  }, []);

  // Clear local session state without calling the API — used when the server
  // tells us the session is already gone (SESSION_REVOKED) so we don't loop
  // trying to refresh a token that will never work again.
  const clearSession = useCallback(() => {
    localStorage.removeItem('accessToken');
    localStorage.removeItem('refreshToken');
    setAccessToken(null);
    setUser(null);
  }, []);

  const logout = useCallback(async () => {
    const refreshToken = localStorage.getItem('refreshToken');
    try {
      if (refreshToken) {
        await api.post('/auth/logout', { refreshToken });
      }
    } catch (e) {
      // best effort
    }
    localStorage.removeItem('accessToken');
    localStorage.removeItem('refreshToken');
    setAccessToken(null);
    setUser(null);
  }, []);

  const refresh = useCallback(async () => {
    const refreshToken = localStorage.getItem('refreshToken');
    if (!refreshToken) throw new Error('No refresh token');
    const res = await api.post('/auth/refresh', { refreshToken });
    const data = res.data?.data || {};
    if (data.accessToken) localStorage.setItem('accessToken', data.accessToken);
    if (data.refreshToken) localStorage.setItem('refreshToken', data.refreshToken);
    setAccessToken(data.accessToken);
    return data;
  }, []);

  const value = {
    user,
    accessToken,
    isLoading,
    loading: isLoading,
    error,
    isAuthenticated: !!user,
    can,
    login,
    loginWithTokens,
    completeMfa,
    applyAuthResult,
    applyTokenPair,
    clearSession,
    refreshUser: loadMe,
    logout,
    refresh,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
