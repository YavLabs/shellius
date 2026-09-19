import { useMemo } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Eye, LayoutGrid, Moon, Sun } from 'lucide-react';
import { AuthContext } from '@/context/AuthContext';
import { useTheme } from '@/context/ThemeContext';
import AuthShell from '@/components/auth/AuthShell';
import Login from './Login';
import Register from './Register';
import ForgotPassword from './ForgotPassword';
import ResetPassword from './ResetPassword';
import AcceptInvite from './AcceptInvite';
import ApproveRequest from './ApproveRequest';
import Device from './Device';
import MfaSetup from './MfaSetup';
import AuthCallback from './AuthCallback';
import Legal from './Legal';
import NotFound from './NotFound';

/**
 * /dummy — gallery of every auth page, rendered with the real components but
 * no real effects: the API client answers from lib/previewMock.js while the
 * URL starts with /dummy (reads get sample data, writes are refused), and
 * the pages get a fake session instead of the real one. Safe to click
 * around; nothing reaches the server and the real session is untouched.
 */
export const PREVIEW_PAGES = [
  { key: 'login', label: 'Sign in', path: '/dummy/login', Component: Login },
  { key: 'register', label: 'Register', path: '/dummy/register', Component: Register },
  { key: 'forgot-password', label: 'Forgot password', path: '/dummy/forgot-password', Component: ForgotPassword },
  { key: 'reset-password', label: 'Reset password', path: '/dummy/password-reset/preview', Component: ResetPassword },
  { key: 'invite', label: 'Accept invite', path: '/dummy/invite/preview', Component: AcceptInvite },
  { key: 'approve', label: 'Approve request (email link)', path: '/dummy/approve/preview', Component: ApproveRequest },
  { key: 'device', label: 'CLI device sign-in', path: '/dummy/device?user_code=WDJB-MJHT', Component: Device, signedIn: true },
  { key: 'mfa-setup', label: 'MFA setup (required)', path: '/dummy/mfa-setup', Component: MfaSetup, signedIn: true },
  { key: 'sso-error', label: 'SSO sign-in failed', path: '/dummy/sso-callback#error=access_denied', Component: AuthCallback },
  { key: 'legal', label: 'Legal document', path: '/dummy/legal/privacy', Component: Legal },
  { key: 'not-found', label: '404 page', path: '/dummy/not-found', Component: NotFound },
];

const refuse = async () => {
  throw Object.assign(new Error('Preview only — nothing was sent.'), { code: 'PREVIEW_ONLY' });
};

function fakeSession(signedIn) {
  const user = signedIn
    ? {
        id: 'preview-user',
        email: 'alex.morgan@example.com',
        name: 'Alex Morgan',
        role: 'member',
        orgName: 'Acme Corp',
        permissions: [],
        features: { personalVault: true },
      }
    : null;
  const noop = () => {};
  return {
    user,
    accessToken: null,
    isLoading: false,
    loading: false,
    error: null,
    isAuthenticated: !!user,
    can: () => false,
    login: refuse,
    loginWithTokens: refuse,
    completeMfa: refuse,
    applyAuthResult: noop,
    applyTokenPair: noop,
    clearSession: noop,
    refreshUser: async () => user,
    logout: noop,
    refresh: refuse,
  };
}

function PreviewBar({ index }) {
  const navigate = useNavigate();
  const { theme, toggleTheme } = useTheme();
  const prev = PREVIEW_PAGES[(index - 1 + PREVIEW_PAGES.length) % PREVIEW_PAGES.length];
  const next = PREVIEW_PAGES[(index + 1) % PREVIEW_PAGES.length];
  const btn =
    'flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground';
  return (
    <div className="fixed right-4 top-4 z-50 flex items-center gap-1 rounded-full border border-border bg-background/80 p-1 pl-3 text-xs shadow-lg backdrop-blur">
      <Eye className="h-3.5 w-3.5 text-amber-500" />
      <span className="mr-1 font-medium text-foreground">Preview</span>
      <select
        aria-label="Page"
        value={PREVIEW_PAGES[index].key}
        onChange={(e) => {
          const p = PREVIEW_PAGES.find((x) => x.key === e.target.value);
          if (p) window.location.assign(p.path);
        }}
        className="h-7 max-w-[11rem] rounded-full border-0 bg-foreground/[0.06] px-2 text-xs text-foreground focus:outline-none"
      >
        {PREVIEW_PAGES.map((p) => (
          <option key={p.key} value={p.key}>
            {p.label}
          </option>
        ))}
      </select>
      <button type="button" className={btn} title={`Previous: ${prev.label}`} onClick={() => window.location.assign(prev.path)}>
        <ChevronLeft className="h-4 w-4" />
      </button>
      <button type="button" className={btn} title={`Next: ${next.label}`} onClick={() => window.location.assign(next.path)}>
        <ChevronRight className="h-4 w-4" />
      </button>
      <button type="button" className={btn} title="Toggle theme" onClick={toggleTheme}>
        {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
      </button>
      <button type="button" className={btn} title="All pages" onClick={() => navigate('/dummy')}>
        <LayoutGrid className="h-4 w-4" />
      </button>
    </div>
  );
}

/** One page under /dummy/... with a fake session and the preview bar. */
export function AuthPreviewPage({ pageKey }) {
  const index = PREVIEW_PAGES.findIndex((p) => p.key === pageKey);
  const page = PREVIEW_PAGES[index];
  const session = useMemo(() => fakeSession(!!page?.signedIn), [page]);
  if (!page) return <NotFound />;
  const { Component } = page;
  return (
    <AuthContext.Provider value={session}>
      {/* key: remount when switching pages so each starts fresh */}
      <Component key={page.key} />
      <PreviewBar index={index} />
    </AuthContext.Provider>
  );
}

/** /dummy — index of every auth page. */
function AuthPreview() {
  const location = useLocation();
  return (
    <AuthShell>
      <div className="w-full max-w-md space-y-6" key={location.key}>
        <div className="text-center">
          <h1 className="text-3xl font-semibold">Auth page previews</h1>
          <p className="mx-auto mt-3 max-w-xs text-sm text-muted-foreground">
            Every sign-in screen with sample data. Nothing you do here is sent to the server.
          </p>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          {PREVIEW_PAGES.map((p) => (
            <a
              key={p.key}
              href={p.path}
              className="rounded-full bg-foreground/[0.04] px-4 py-2.5 text-center text-sm text-foreground/85 ring-1 ring-foreground/[0.06] transition-colors hover:bg-foreground/[0.08] hover:text-foreground"
            >
              {p.label}
            </a>
          ))}
        </div>
        <p className="text-center text-xs text-muted-foreground">
          <Link to="/" className="hover:text-foreground">
            Back to the app
          </Link>
        </p>
      </div>
    </AuthShell>
  );
}

export default AuthPreview;
