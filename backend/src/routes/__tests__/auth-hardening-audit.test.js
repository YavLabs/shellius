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
const apiTokenMiddlewareSrc = read('../../middleware/apiTokenAuth.js');
const permissionsSrc = read('../../config/permissions.js');
const authServiceSrc = read('../../services/authService.js');
const ssoServiceSrc = read('../../services/ssoService.js');

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
    // The authorize URL is built by beginAuthorize(), shared with the
    // Profile "connect" flow (POST /connect/start).
    expect(block).toContain('beginAuthorize');
    const helperIdx = ssoRouteSrc.indexOf('async function beginAuthorize');
    expect(helperIdx).toBeGreaterThan(-1);
    const helper = ssoRouteSrc.slice(helperIdx, helperIdx + 2200);
    expect(helper).toContain('generatePkce');
    expect(helper).toContain('code_challenge_method');
    expect(helper).toContain("'S256'");
    expect(helper).toContain('nonce');
  });

  test('POST /connect/start is authenticated and binds the state to the signed-in user', () => {
    const idx = ssoRouteSrc.indexOf("'/connect/start'");
    expect(idx).toBeGreaterThan(-1);
    const block = ssoRouteSrc.slice(idx, idx + 1200);
    expect(block).toContain('authenticate');
    expect(block).toContain("mode: 'connect', userId: req.user.userId");
  });

  test('legacy start handler still delegates PKCE/nonce generation', () => {
    const idx = ssoRouteSrc.indexOf("router.get(\n  '/:orgSlug',");
    const block = ssoRouteSrc.slice(idx, idx + 2200);
    expect(block).not.toContain('generatePkce');
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
    const tailBlock = ssoRouteSrc.slice(tailIdx, tailIdx + 3500);
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
    expect(unlockBlock).toContain("requirePermission('users.reset_credentials')");
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

  test('a service account can never hold a browser session', () => {
    expect(authMiddlewareSrc).toContain("user.kind === 'service'");
  });
});

describe('API tokens (docs/api-tokens.md)', () => {
  test('the bearer entry point chooses its path by token prefix', () => {
    expect(authMiddlewareSrc).toContain('looksLikeApiToken');
    expect(authMiddlewareSrc).toContain('apiTokenAuth');
  });

  test('tokens are denied the endpoints that would let them escalate', () => {
    for (const path of ["'/api/auth'", "'/api/mfa'", "'/api/vault'", "'/api/terminal'", "'/api/tokens'", "'/api/service-accounts'"]) {
      expect(apiTokenMiddlewareSrc).toContain(path);
    }
    expect(apiTokenMiddlewareSrc).toContain('TOKEN_NOT_ALLOWED_HERE');
  });

  test('the deny-list is checked before the token is looked up', () => {
    const denyIdx = apiTokenMiddlewareSrc.indexOf('isForbiddenPath(req)');
    const lookupIdx = apiTokenMiddlewareSrc.indexOf('prisma.apiToken.findUnique');
    expect(denyIdx).toBeGreaterThan(-1);
    expect(lookupIdx).toBeGreaterThan(denyIdx);
  });

  test('permissions are intersected with the live role and stripped of non-delegable keys', () => {
    expect(apiTokenMiddlewareSrc).toContain('permissionsForUser');
    expect(apiTokenMiddlewareSrc).toContain('NON_DELEGABLE_PERMISSIONS');
    expect(permissionsSrc).toContain('delegable: false');
  });

  test('an inactive principal cannot use a token', () => {
    expect(apiTokenMiddlewareSrc).toContain('TOKEN_PRINCIPAL_INACTIVE');
    expect(apiTokenMiddlewareSrc).toContain("user.status !== 'active'");
  });

  test('service accounts are excluded from password sign-in and SSO email matching', () => {
    expect(authServiceSrc).toContain("kind: 'human'");
    expect(ssoServiceSrc).toContain("kind: 'human'");
  });
});

describe('SSO account linking (docs/auth-hardening.md "Linking SSO accounts")', () => {
  test('confirm-link and its code/info endpoints are rate-limited and Joi-validated', () => {
    for (const path of ["'/confirm-link'", "'/confirm-link/send-code'", "'/link/info'", "'/link/cancel'"]) {
      const idx = ssoRouteSrc.indexOf(path);
      expect(idx).toBeGreaterThan(-1);
      const block = ssoRouteSrc.slice(idx, idx + 200);
      expect(block).toContain('authLimiter');
      expect(block).toContain('validate(');
    }
    for (const path of ["'/link/approve'", "'/link/approve-info'"]) {
      const idx = ssoRouteSrc.indexOf(path);
      expect(idx).toBeGreaterThan(-1);
      expect(ssoRouteSrc.slice(idx, idx + 200)).toContain('tokenActionLimiter');
    }
  });

  test('the callback hands email matches needing confirmation to a pending link, never a session', () => {
    const idx = ssoRouteSrc.indexOf('async function finishSsoCallback');
    const block = ssoRouteSrc.slice(idx, idx + 2500);
    const pendingIdx = block.indexOf('user.pendingLink');
    expect(pendingIdx).toBeGreaterThan(-1);
    expect(block.indexOf('saveExchangeCode')).toBeGreaterThan(pendingIdx);
    expect(block).toContain('/sso/link#');
  });

  test('self-service unlink uses the ACTIONS catalogue (no raw audit strings)', () => {
    expect(authRouteSrc).not.toContain("'auth.identity.unlinked'");
    const idx = authRouteSrc.indexOf("'/identities/:id'");
    const block = authRouteSrc.slice(idx, idx + 600);
    expect(block).toContain('ssoLinkService.unlinkOwnIdentity');
  });

  test('POST /password/set is authenticated, rate-limited and uses the registration password rules', () => {
    const idx = authRouteSrc.indexOf("'/password/set',");
    const block = authRouteSrc.slice(idx, idx + 400);
    expect(block).toContain('authenticate');
    expect(block).toContain('setPasswordLimiter');
    expect(block).toContain('validate(setPasswordSchema)');
    const schemaIdx = authRouteSrc.indexOf('const setPasswordSchema');
    expect(authRouteSrc.slice(schemaIdx, schemaIdx + 200)).toContain('strongPasswordSchema');
  });

  test('admin identity endpoints require users.manage_identities', () => {
    for (const path of ["'/:id/identities'", "'/:id/identities/:identityId'"]) {
      const idx = usersRouteSrc.indexOf(path);
      expect(idx).toBeGreaterThan(-1);
      expect(usersRouteSrc.slice(idx, idx + 120)).toContain("requirePermission('users.manage_identities')");
    }
  });
});
