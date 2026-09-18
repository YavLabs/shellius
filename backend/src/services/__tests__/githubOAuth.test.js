/**
 * githubOAuth.js — endpoint resolution (github.com vs GHE), email selection
 * (primary && verified), and org-membership checks. All outbound calls are
 * mocked (`global.fetch`) — no live network / DB required.
 */

// Note: jest.mock()/unstable_mockModule is unreliable under this repo's
// Jest + native-ESM setup (see caService.test.js) — so unlike a typical
// Jest suite, this does NOT mock ssoConfigService.guardSsrf(). The API
// helpers below (fetchUser/fetchEmails/isActiveOrgMember) resolve the real
// DNS name of github.com (cheap, no outbound HTTP — fetch() itself is
// stubbed) before hitting the mocked fetch.
import { jest } from '@jest/globals';
import * as githubOAuth from '../githubOAuth.js';

describe('githubOAuth.resolveEndpoints', () => {
  test('defaults to github.com / api.github.com', () => {
    const eps = githubOAuth.resolveEndpoints(undefined);
    expect(eps.authorizeUrl).toBe('https://github.com/login/oauth/authorize');
    expect(eps.tokenUrl).toBe('https://github.com/login/oauth/access_token');
    expect(eps.apiBase).toBe('https://api.github.com');
  });

  test('GitHub Enterprise Server uses /api/v3', () => {
    const eps = githubOAuth.resolveEndpoints('https://ghe.example.com');
    expect(eps.authorizeUrl).toBe('https://ghe.example.com/login/oauth/authorize');
    expect(eps.tokenUrl).toBe('https://ghe.example.com/login/oauth/access_token');
    expect(eps.apiBase).toBe('https://ghe.example.com/api/v3');
  });
});

describe('githubOAuth.defaultScopes', () => {
  test('excludes read:org when allowedOrgs is empty', () => {
    expect(githubOAuth.defaultScopes([])).toBe('read:user user:email');
  });
  test('includes read:org when allowedOrgs is non-empty', () => {
    expect(githubOAuth.defaultScopes(['acme'])).toBe('read:user user:email read:org');
  });
});

describe('githubOAuth.buildAuthorizeUrl', () => {
  test('includes PKCE code_challenge (S256) and state', () => {
    const url = githubOAuth.buildAuthorizeUrl({
      issuerUrl: null,
      clientId: 'client-123',
      redirectUri: 'https://shellius.example.com/api/auth/sso/callback/abc',
      scopes: 'read:user user:email',
      state: 'state-abc',
      codeChallenge: 'challenge-xyz',
    });
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(parsed.searchParams.get('client_id')).toBe('client-123');
    expect(parsed.searchParams.get('state')).toBe('state-abc');
    expect(parsed.searchParams.get('code_challenge')).toBe('challenge-xyz');
    expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
  });
});

describe('githubOAuth — mocked API calls', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  test('fetchUser maps subject/name/picture', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: 42, login: 'octocat', name: null, avatar_url: 'https://avatars/octocat.png' }),
    });
    const user = await githubOAuth.fetchUser(null, 'token-abc');
    expect(user).toEqual({ subject: '42', login: 'octocat', name: 'octocat', picture: 'https://avatars/octocat.png' });
  });

  test('fetchEmails returns the raw list', async () => {
    const emails = [
      { email: 'secondary@example.com', primary: false, verified: true },
      { email: 'primary@example.com', primary: true, verified: true },
    ];
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => emails });
    const result = await githubOAuth.fetchEmails(null, 'token-abc');
    expect(result).toEqual(emails);
  });

  test('fetchPrimaryVerifiedEmail selects primary && verified only', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        { email: 'unverified-primary@example.com', primary: true, verified: false },
        { email: 'verified-secondary@example.com', primary: false, verified: true },
      ],
    });
    const result = await githubOAuth.fetchPrimaryVerifiedEmail(null, 'token-abc');
    expect(result).toBeNull(); // primary email is unverified — no match
  });

  test('fetchPrimaryVerifiedEmail returns the email when primary && verified', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ email: 'Primary@Example.com', primary: true, verified: true }],
    });
    const result = await githubOAuth.fetchPrimaryVerifiedEmail(null, 'token-abc');
    expect(result).toEqual({ email: 'primary@example.com', verified: true });
  });

  test('isActiveOrgMember true when membership state is active', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ state: 'active' }) });
    const result = await githubOAuth.isActiveOrgMember(null, 'token-abc', 'acme');
    expect(result).toBe(true);
  });

  test('isActiveOrgMember false when membership state is pending', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ state: 'pending' }) });
    const result = await githubOAuth.isActiveOrgMember(null, 'token-abc', 'acme');
    expect(result).toBe(false);
  });

  test('isActiveOrgMember false on 404 (not a member)', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 404 });
    const result = await githubOAuth.isActiveOrgMember(null, 'token-abc', 'acme');
    expect(result).toBe(false);
  });

  test('exchangeCode throws ApiError on error response', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ error: 'bad_verification_code', error_description: 'The code has expired' }),
    });
    await expect(
      githubOAuth.exchangeCode({
        issuerUrl: null,
        clientId: 'id',
        clientSecret: 'secret',
        code: 'code',
        redirectUri: 'https://shellius.example.com/callback',
        codeVerifier: 'verifier',
      })
    ).rejects.toThrow(/expired/);
  });
});
