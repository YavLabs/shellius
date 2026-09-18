/**
 * Source-code audits for auth-hardening behaviors that are impractical to
 * exercise end-to-end in this test harness (no real IdP, no real SMTP), but
 * whose presence in the source is a strong, stable guarantee — same pattern
 * used throughout this repo (see accessRequestService.test.js,
 * auth-registration.test.js).
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const read = (rel) => readFileSync(join(__dirname, rel), 'utf8');

const mfaRouteSrc = read('../mfa.js');
const ssoRouteSrc = read('../sso.js');
const authRouteSrc = read('../auth.js');
const usersRouteSrc = read('../users.js');
const authMiddlewareSrc = read('../../middleware/auth.js');

describe('POST /api/mfa/disable — requires proof of possession', () => {
  test('Joi schema requires either password XOR method, and method implies code', () => {
    const idx = mfaRouteSrc.indexOf('disableSchema');
    const block = mfaRouteSrc.slice(idx, idx + 400);
    expect(block).toContain(".xor('password', 'method')");
    expect(block).toContain(".and('method', 'code')");
  });

  test('verifies via bcrypt.compare for password, or verifyFactor for method+code', () => {
    const idx = mfaRouteSrc.indexOf("'/disable'");
    const block = mfaRouteSrc.slice(idx, idx + 1200);
    expect(block).toContain('bcrypt.compare');
    expect(block).toContain('mfaService.verifyFactor');
  });
});

describe('POST /api/mfa/backup-codes/regenerate — requires a fresh code when enrolled', () => {
  test('requires method + code via Joi and verifies via verifyFactor', () => {
    const idx = mfaRouteSrc.indexOf('regenerateSchema');
    const block = mfaRouteSrc.slice(idx, idx + 600);
    expect(block).toContain('.required()');
    const routeIdx = mfaRouteSrc.indexOf("'/backup-codes/regenerate'");
    const routeBlock = mfaRouteSrc.slice(routeIdx, routeIdx + 900);
    expect(routeBlock).toContain('mfaService.verifyFactor');
  });
});

describe('POST /api/mfa/email/send-code — self-service OTP', () => {
  test('route exists, requires mfaEmailEnabled, and is rate-limited via mfaService', () => {
    expect(mfaRouteSrc).toContain("/email/send-code");
    const idx = mfaRouteSrc.indexOf('/email/send-code');
    const block = mfaRouteSrc.slice(idx, idx + 700);
    expect(block).toContain('mfaEmailEnabled');
    expect(block).toContain('sendSelfServiceEmailOtp');
    expect(block).toContain('MFA_TOO_MANY_ATTEMPTS');
  });
});

describe('SSO callback — PKCE, nonce, state cookie, SSRF guard, jose verification', () => {
  test('generates a PKCE code_verifier/code_challenge (S256) and nonce on initiate', () => {
    const idx = ssoRouteSrc.indexOf("router.get(\n  '/:orgSlug',");
    expect(idx).toBeGreaterThan(-1);
    // Revision 2: this handler also branches to the GitHub authorize-URL
    // path (no nonce — GitHub is OAuth2, not OIDC) before reaching the OIDC
    // branch, so the window needs to be wide enough to cover both.
    const block = ssoRouteSrc.slice(idx, idx + 2200);
    expect(block).toContain('generatePkce');
    expect(block).toContain('code_challenge_method');
    expect(block).toContain("'S256'");
    expect(block).toContain('nonce');
  });

  test('binds state to the browser with an HttpOnly cookie', () => {
    expect(ssoRouteSrc).toContain('SSO_STATE_COOKIE');
    expect(ssoRouteSrc).toMatch(/httpOnly:\s*true/);
  });

  test('callback validates the state cookie before proceeding', () => {
    // Revision 2: state/cookie validation lives in the shared dispatcher
    // (runSsoCallback) so it applies uniformly to both the OIDC and GitHub
    // callback handlers, which it calls only after validation passes.
    const idx = ssoRouteSrc.indexOf('async function runSsoCallback');
    expect(idx).toBeGreaterThan(-1);
    const block = ssoRouteSrc.slice(idx, idx + 500);
    expect(block).toContain('cookieState');
    expect(block).toContain('state_mismatch');
    expect(ssoRouteSrc.indexOf('return runOidcCallback(req, res,', idx)).toBeGreaterThan(idx);
  });

  test('verifies the ID token via jose (JWKS, issuer, audience) and checks nonce', () => {
    expect(ssoRouteSrc).toContain("from 'jose'");
    expect(ssoRouteSrc).toContain('jwtVerify');
    expect(ssoRouteSrc).toContain('createRemoteJWKSet');
    const idx = ssoRouteSrc.indexOf('jwtVerify(tokens.id_token');
    const block = ssoRouteSrc.slice(idx - 200, idx + 300);
    expect(block).toContain('issuer');
    expect(block).toContain('audience');
    const nonceIdx = ssoRouteSrc.indexOf('idClaims.nonce');
    expect(nonceIdx).toBeGreaterThan(-1);
  });

  test('applies the SSRF guard to token/userinfo/jwks endpoints, not just the issuer', () => {
    const idx = ssoRouteSrc.indexOf('async function runOidcCallback');
    const block = ssoRouteSrc.slice(idx, idx + 2000);
    expect(block).toContain('guardSsrf(discovery.token_endpoint)');
    expect(block).toContain('guardSsrf(discovery.userinfo_endpoint)');
    expect(block).toContain('guardSsrf(discovery.jwks_uri)');
  });

  test('redirects on success with a one-time #code, never raw tokens', () => {
    const idx = ssoRouteSrc.indexOf('async function runOidcCallback');
    const block = ssoRouteSrc.slice(idx, idx + 5000);
    expect(block).not.toMatch(/access_token:\s*accessToken/);
    // Revision 2: runOidcCallback (and runGithubCallback) both hand off to a
    // shared finishSsoCallback() for reconciliation + the one-time exchange
    // code, so the OIDC and GitHub paths can't diverge on this guarantee.
    const tailIdx = ssoRouteSrc.indexOf('async function finishSsoCallback');
    const tailBlock = ssoRouteSrc.slice(tailIdx, tailIdx + 1200);
    expect(tailBlock).toContain('oneTimeCode');
    expect(tailBlock).toContain('saveExchangeCode');
    expect(block).toContain('finishSsoCallback');
  });

  test('POST /exchange is a login-shaped endpoint that runs mfaGate', () => {
    const idx = ssoRouteSrc.indexOf("'/exchange'");
    const block = ssoRouteSrc.slice(idx, idx + 700);
    expect(block).toContain('authService.mfaGate');
    expect(block).toContain('authService.issueSession');
  });

  test('audits auth.sso_login on success and auth.sso_failed on reconciliation failure', () => {
    expect(ssoRouteSrc).toContain('ACTIONS.auth.sso_login');
    expect(ssoRouteSrc).toContain('ACTIONS.auth.sso_failed');
  });
});

describe('Login hardening', () => {
  test('authService.login is used by POST /login (delegates lockout/timing logic to the service)', () => {
    const idx = authRouteSrc.indexOf("'/login'");
    const block = authRouteSrc.slice(idx, idx + 400);
    expect(block).toContain('authService.login');
  });

  test('password-reset/:token/reset blocks reactivating suspended/deactivated/deleted accounts', () => {
    const idx = authRouteSrc.indexOf("'/password-reset/:token/reset'");
    const block = authRouteSrc.slice(idx, idx + 1600);
    expect(block).toContain('ACCOUNT_DISABLED');
    expect(block).toContain('suspended');
    expect(block).toContain('deactivated');
  });

  test('password-reset/:token/reset revokes all sessions and runs mfaGate', () => {
    const idx = authRouteSrc.indexOf("'/password-reset/:token/reset'");
    const block = authRouteSrc.slice(idx, idx + 2000);
    expect(block).toContain('authService.revokeAllSessions');
    expect(block).toContain('authService.mfaGate');
  });

  test('invite/:token/accept runs mfaGate before issuing a session', () => {
    const idx = authRouteSrc.indexOf("'/invite/:token/accept'");
    const block = authRouteSrc.slice(idx, idx + 2000);
    expect(block).toContain('authService.mfaGate');
    expect(block).toContain('authService.issueSession');
  });
});

describe('Session invalidation on role/status change and admin actions', () => {
  test('POST /api/users/:id/unlock and /:id/revoke-sessions exist and are admin-gated', () => {
    expect(usersRouteSrc).toContain("/:id/unlock");
    expect(usersRouteSrc).toContain("/:id/revoke-sessions");
    const unlockIdx = usersRouteSrc.indexOf("/:id/unlock");
    const unlockBlock = usersRouteSrc.slice(unlockIdx - 200, unlockIdx + 300);
    expect(unlockBlock).toContain('requireRole');
  });

  test('PUT /api/users/me/password returns a fresh token pair', () => {
    const idx = usersRouteSrc.indexOf("'/me/password'");
    const block = usersRouteSrc.slice(idx, idx + 1200);
    expect(block).toContain('userService.changePassword');
    expect(block).toContain('tokens');
  });
});

describe('authenticate middleware — enforced-MFA allowlist', () => {
  test('allowlists /api/mfa/*, GET /api/auth/me, POST /api/auth/logout, POST /api/auth/refresh, GET /api/auth/sessions', () => {
    expect(authMiddlewareSrc).toContain("url.startsWith('/api/mfa')");
    expect(authMiddlewareSrc).toContain("'/api/auth/me'");
    expect(authMiddlewareSrc).toContain("'/api/auth/logout'");
    expect(authMiddlewareSrc).toContain("'/api/auth/refresh'");
    expect(authMiddlewareSrc).toContain("'/api/auth/sessions'");
  });

  test('loads the user and rejects non-active / stale-session tokens with SESSION_REVOKED', () => {
    expect(authMiddlewareSrc).toContain('SESSION_REVOKED');
    expect(authMiddlewareSrc).toContain('sessionsValidFrom');
  });
});
