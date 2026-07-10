import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import api from '@/services/api';

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
      const msg =
        e.response?.status === 401
          ? 'Invalid email or password'
          : e.response?.data?.error?.message || e.message || 'Login failed';
      setError(msg);
      throw new Error(msg);
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
    login,
    loginWithTokens,
    completeMfa,
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
