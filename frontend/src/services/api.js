import axios from 'axios';

const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || '/api',
  headers: {
    'Content-Type': 'application/json',
  },
});

api.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem('accessToken');
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => Promise.reject(error)
);

let refreshPromise = null;

async function performRefresh() {
  const refreshToken = localStorage.getItem('refreshToken');
  if (!refreshToken) throw new Error('No refresh token');
  const res = await axios.post(
    (import.meta.env.VITE_API_URL || '/api') + '/auth/refresh',
    { refreshToken },
    { headers: { 'Content-Type': 'application/json' } }
  );
  const data = res.data?.data || {};
  if (data.accessToken) localStorage.setItem('accessToken', data.accessToken);
  if (data.refreshToken) localStorage.setItem('refreshToken', data.refreshToken);
  return data.accessToken;
}

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;
    const status = error.response?.status;
    const code = error.response?.data?.error?.code;
    const url = originalRequest?.url || '';

    // The server has authoritatively revoked this session (role change,
    // suspension, refresh-token reuse, etc). Refreshing would just fail
    // again, so go straight to sign-in instead of looping through the
    // refresh interceptor below.
    if (status === 401 && code === 'SESSION_REVOKED') {
      localStorage.removeItem('accessToken');
      localStorage.removeItem('refreshToken');
      if (window.location.pathname !== '/login') {
        window.location.href = '/login?reason=session_revoked';
      }
      return Promise.reject(error);
    }

    // Org enforces MFA and this user hasn't enrolled yet — every route except
    // the handful the backend exempts (auth/me, logout, refresh, sessions,
    // /mfa/*) returns this until they finish setup.
    if (status === 403 && code === 'MFA_SETUP_REQUIRED') {
      if (window.location.pathname !== '/mfa-setup') {
        window.location.href = '/mfa-setup';
      }
      return Promise.reject(error);
    }

    if (
      status === 401 &&
      !originalRequest._retry &&
      !url.includes('/auth/login') &&
      !url.includes('/auth/refresh')
    ) {
      originalRequest._retry = true;
      try {
        if (!refreshPromise) {
          refreshPromise = performRefresh().finally(() => {
            refreshPromise = null;
          });
        }
        const newToken = await refreshPromise;
        if (newToken) {
          originalRequest.headers.Authorization = `Bearer ${newToken}`;
          return api(originalRequest);
        }
      } catch (e) {
        localStorage.removeItem('accessToken');
        localStorage.removeItem('refreshToken');
        if (window.location.pathname !== '/login') {
          window.location.href = '/login';
        }
      }
    }
    return Promise.reject(error);
  }
);

export default api;
