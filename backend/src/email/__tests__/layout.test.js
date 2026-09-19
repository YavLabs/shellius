/**
 * Email layout / branding: hosted PNG lockup when the app URL is known, an
 * HTML-only wordmark otherwise (never a broken image, never a data: URI),
 * brand colours, and the gradient button with its solid fallback.
 */

import { renderLayout, renderLogo } from '../layout.js';
import { button } from '../button.js';
import { configuredAppUrl, logoUrl, BRAND } from '../brand.js';

const URL_VARS = ['APP_URL', 'PUBLIC_BASE_URL', 'FRONTEND_URL', 'TRAEFIK_HOST'];
const saved = {};

beforeEach(() => {
  for (const k of URL_VARS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of URL_VARS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('brand.configuredAppUrl', () => {
  test('null when nothing is configured', () => {
    expect(configuredAppUrl()).toBeNull();
    expect(logoUrl()).toBeNull();
  });

  test('APP_URL wins and trailing slashes are dropped', () => {
    process.env.APP_URL = 'https://shellius.example.com/';
    process.env.TRAEFIK_HOST = 'other.example.com';
    expect(configuredAppUrl()).toBe('https://shellius.example.com');
    expect(logoUrl()).toBe('https://shellius.example.com/brand/png/shellius-lockup-dark-bg-640x128.png');
  });

  test('TRAEFIK_HOST derives https', () => {
    process.env.TRAEFIK_HOST = 'sh.example.com';
    expect(configuredAppUrl()).toBe('https://sh.example.com');
  });

  test('localhost does not count (mail clients cannot reach it)', () => {
    process.env.APP_URL = 'http://localhost:5173';
    expect(configuredAppUrl()).toBeNull();
    process.env.APP_URL = 'http://127.0.0.1:3000';
    expect(configuredAppUrl()).toBeNull();
  });
});

describe('layout header', () => {
  test('hosted PNG lockup at 200x40 with alt text when APP_URL is set', () => {
    process.env.APP_URL = 'https://shellius.example.com';
    const html = renderLayout({ title: 't', bodyHtml: '<p>b</p>' });
    expect(html).toContain('src="https://shellius.example.com/brand/png/shellius-lockup-dark-bg-640x128.png"');
    expect(html).toMatch(/width="200" height="40" alt="Shellius"/);
  });

  test('HTML wordmark (no <img>) when no app URL is configured', () => {
    const logo = renderLogo();
    expect(logo).not.toContain('<img');
    expect(logo).toContain('SHELL');
    expect(logo).toContain('>US<');
    expect(logo).toContain(BRAND.sky);
    expect(renderLayout({ title: 't', bodyHtml: '' })).not.toContain('<img');
  });

  test('never embeds data: URIs (blocked by Gmail/Outlook)', () => {
    expect(renderLayout({ title: 't', bodyHtml: '' })).not.toContain('data:');
    process.env.APP_URL = 'https://x.example.com';
    expect(renderLayout({ title: 't', bodyHtml: '' })).not.toContain('data:');
  });

  test('uses the brand palette with solid bgcolor fallbacks for gradients', () => {
    const html = renderLayout({ title: 't', bodyHtml: '' });
    expect(html).toContain(`bgcolor="${BRAND.ink}"`);
    expect(html).toContain(`linear-gradient(135deg,${BRAND.ink} 0%,${BRAND.indigo} 100%)`);
    expect(html).toContain(`bgcolor="${BRAND.sky}"`);
    expect(html).toContain(BRAND.lavender);
  });
});

describe('button', () => {
  test('brand button: Sky→Lavender gradient, solid Sky fallback, Ink text', () => {
    const html = button({ href: 'https://x', label: 'Go' });
    expect(html).toContain(`background:${BRAND.sky};`);
    expect(html).toContain(`linear-gradient(135deg,${BRAND.sky} 0%,${BRAND.lavender} 100%)`);
    expect(html).toContain(`color:${BRAND.ink};`);
    expect(html).toContain(`fillcolor="${BRAND.sky}"`); // Outlook VML
  });

  test('explicit colour → solid fill with white text', () => {
    const html = button({ href: 'https://x', label: 'Reject', color: '#dc2626' });
    expect(html).toContain('background:#dc2626;');
    expect(html).not.toContain('linear-gradient');
    expect(html).toContain('color:#ffffff;');
  });
});
