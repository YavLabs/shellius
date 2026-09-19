/**
 * Preview mode for /dummy/* (auth page gallery, pages/AuthPreview.jsx).
 *
 * While the browser is on a /dummy URL, every request made through the
 * shared axios client is answered here instead of going to the server:
 * reads get canned data so each page renders its real form state, and
 * writes are refused with a "preview only" message. Nothing leaves the
 * browser. Outside /dummy this module does nothing.
 */

export const PREVIEW_PREFIX = '/dummy';

export function isPreview() {
  return typeof window !== 'undefined' && window.location.pathname.startsWith(PREVIEW_PREFIX);
}

const PREVIEW_MESSAGE = 'Preview only — nothing was sent.';

// A small fake QR code (deterministic blocks), as an SVG data URL.
function fakeQr() {
  let rects = '';
  let seed = 7;
  for (let y = 0; y < 25; y++) {
    for (let x = 0; x < 25; x++) {
      seed = (seed * 9301 + 49297) % 233280;
      const finder = (x < 7 && y < 7) || (x > 17 && y < 7) || (x < 7 && y > 17);
      const on = finder
        ? x % 6 === 0 || y % 6 === 0 || (x % 6 >= 2 && x % 6 <= 4 && y % 6 >= 2 && y % 6 <= 4) || x === 24 || y === 24
        : seed / 233280 > 0.5;
      if (on) rects += `<rect x="${x}" y="${y}" width="1" height="1"/>`;
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-2 -2 29 29"><rect x="-2" y="-2" width="29" height="29" fill="#fff"/><g fill="#111">${rects}</g></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

const inAnHour = () => new Date(Date.now() + 3600 * 1000).toISOString();

// [method, url regex, response data] — first match wins. `null` data = refuse.
const ROUTES = [
  ['get', /^\/auth\/registration-status$/, { enabled: true }],
  ['get', /^\/auth\/sso\/public-status$/, { enabled: false, providers: [] }],
  ['post', /^\/auth\/login-options$/, { hasPassword: true }],
  ['post', /^\/auth\/password-reset$/, { sent: true }],
  ['get', /^\/auth\/password-reset\/[^/]+$/, { user: { email: 'alex.morgan@example.com' }, expiresAt: inAnHour() }],
  [
    'get',
    /^\/auth\/invite\/[^/]+$/,
    {
      user: { email: 'alex.morgan@example.com', name: 'Alex Morgan' },
      org: { name: 'Acme Corp' },
      role: 'member',
      expiresAt: inAnHour(),
    },
  ],
  [
    'get',
    /^\/approvals\/[^/]+$/,
    {
      request: {
        id: 'preview',
        status: 'PENDING',
        requester: { id: 'u1', name: 'Priya Sharma', email: 'priya.sharma@example.com' },
        server: { id: 's1', displayName: 'prod-db-01', hostname: 'prod-db-01.internal', environment: 'prod' },
        requestedPrincipal: 'deploy',
        requestedDuration: 3600,
        reason: 'Hotfix for payment retries (INC-4821)',
        createdAt: new Date().toISOString(),
      },
    },
  ],
  ['get', /^\/mfa$/, { enrolled: false, methods: [], policy: { required: true, allowTotp: true, allowEmailOtp: true } }],
  ['post', /^\/mfa\/totp\/begin$/, { qrDataUrl: fakeQr(), secret: 'JBSW Y3DP EHPK 3PXP' }],
  ['post', /^\/auth\/device\/(approve|deny)$/, { ok: true }],
];

function reply(config, status, data) {
  return { data, status, statusText: String(status), headers: {}, config, request: {} };
}

/** axios adapter used for every request while on /dummy. */
export async function previewAdapter(config) {
  const method = (config.method || 'get').toLowerCase();
  const url = (config.url || '').replace(/^https?:\/\/[^/]+/, '').replace(/^\/api/, '').split('?')[0];
  await new Promise((r) => setTimeout(r, 350)); // feel like a request
  const match = ROUTES.find(([m, re]) => m === method && re.test(url));
  if (match) return reply(config, 200, { success: true, data: match[2] });

  const error = new Error(PREVIEW_MESSAGE);
  error.isAxiosError = true;
  error.config = config;
  error.response = reply(config, 400, { success: false, error: { code: 'PREVIEW_ONLY', message: PREVIEW_MESSAGE } });
  throw error;
}
