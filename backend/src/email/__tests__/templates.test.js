/**
 * Email template registry tests (Phase 16C).
 *
 * Verifies every registered template renders without throwing, returns
 * the {subject, html, text} contract, escapes user-supplied values,
 * and starts the subject with the [Shellius] tag.
 */

import { renderTemplate, TEMPLATE_NAMES } from '../index.js';
import { escapeHtml } from '../escape.js';

const SAMPLES = {
  invite: { recipientName: '<script>x</script>', orgName: 'Acme & Co', inviteUrl: 'https://x.test/i/1', expiresInHours: 168 },
  passwordReset: { recipientName: 'A', resetUrl: 'https://x.test/r/1', expiresInHours: 1 },
  passwordChanged: { recipientName: 'A', ipAddress: '1.2.3.4', userAgent: 'Chrome', when: '2026-04-07T01:00:00Z' },
  accessRequestSubmitted: { reviewerName: 'B', requesterName: 'A', serverHostname: 'h', environment: 'prod', reason: 'r', reviewUrl: 'https://x.test/ar' },
  accessRequestApprovalNeeded: { approverName: 'B', requesterName: 'A', serverHostname: 'h', environment: 'prod', reason: 'r', durationLabel: '2 hours', approveUrl: 'https://x.test/approve/t?intent=approve', rejectUrl: 'https://x.test/approve/t?intent=reject' },
  accessRequestApproved: { recipientName: 'A', serverHostname: 'h', environment: 'prod', expiresAt: '2026-04-07T02:00:00Z', connectUrl: 'https://x.test/c' },
  inviteSso: { recipientName: 'A', orgName: 'Acme', loginUrl: 'https://x.test/login', providerLabel: 'Google' },
  mfaOtp: { recipientName: 'A', code: '123456', minutes: 10 },
  accessRequestDenied: { recipientName: 'A', serverHostname: 'h', deniedReason: 'no' },
  certificateExpiring: { recipientName: 'A', serverHostname: 'h', expiresAt: '2026-04-07T02:00:00Z', renewUrl: 'https://x.test/n' },
  verifyEmail: { recipientName: 'A', verifyUrl: 'https://x.test/v/1', expiresInHours: 24 },
  accountDeleted: { recipientName: 'A', when: '2026-04-07T01:00:00Z', gracePeriodDays: 30 },
  smtpTest: { recipientName: 'A', orgName: 'Acme', host: 'smtp.gmail.com', port: 587, useTls: true, when: '2026-04-07T01:00:00Z' },
  emailTest: { recipientName: 'A', orgName: 'Acme', providerName: 'Company <Gmail>', providerLabel: 'Google (Gmail API)', fromAddress: 'ops@acme.test', when: '2026-04-07T01:00:00Z' },
};

describe('email templates — registry', () => {
  test('TEMPLATE_NAMES contains every expected template', () => {
    const expected = Object.keys(SAMPLES);
    expect(TEMPLATE_NAMES.sort()).toEqual(expected.sort());
  });

  test('unknown template name throws', () => {
    expect(() => renderTemplate('does-not-exist', {})).toThrow(/unknown email template/i);
  });
});

describe('email templates — render contract', () => {
  for (const name of Object.keys(SAMPLES)) {
    test(`${name} returns { subject, html, text }`, () => {
      const result = renderTemplate(name, SAMPLES[name]);
      expect(result.subject).toEqual(expect.any(String));
      expect(result.html).toEqual(expect.any(String));
      expect(result.text).toEqual(expect.any(String));
      expect(result.subject).toMatch(/^\[Shellius\]/);
      expect(result.html).toMatch(/<!doctype html>/i);
      expect(result.html).toContain('<body');
      expect(result.text.length).toBeGreaterThan(0);
    });
  }
});

describe('email templates — XSS escape', () => {
  test('invite template escapes <script> in recipientName', () => {
    const { html } = renderTemplate('invite', SAMPLES.invite);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  test('invite template escapes & in orgName', () => {
    const { html } = renderTemplate('invite', SAMPLES.invite);
    expect(html).toContain('Acme &amp; Co');
  });
});

describe('email templates — new branded layout', () => {
  const saved = process.env.APP_URL;
  beforeAll(() => {
    process.env.APP_URL = 'https://shellius.example.com';
  });
  afterAll(() => {
    if (saved === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = saved;
  });

  for (const name of Object.keys(SAMPLES)) {
    test(`${name} renders the hosted lockup, no data: URIs, and a plain-text part`, () => {
      const { html, text } = renderTemplate(name, SAMPLES[name]);
      expect(html).toContain('https://shellius.example.com/brand/png/shellius-lockup-dark-bg-640x128.png');
      expect(html).not.toContain('data:image');
      expect(text).not.toMatch(/<(table|td|p|div|a|br|img)\b/i);
    });
  }
});

describe('emailTest template', () => {
  test('names the provider, type, sender and timestamp (escaped in HTML)', () => {
    const { subject, html, text } = renderTemplate('emailTest', SAMPLES.emailTest);
    expect(subject).toBe('[Shellius] Test email');
    expect(html).toContain('Company &lt;Gmail&gt;');
    expect(html).toContain('Google (Gmail API)');
    expect(html).toContain('ops@acme.test');
    expect(html).toContain('2026-04-07T01:00:00Z');
    expect(text).toContain('Provider: Company <Gmail>');
    expect(text).toContain('Sent at:  2026-04-07T01:00:00Z');
  });
});

describe('escapeHtml helper', () => {
  test('escapes the five HTML metacharacters', () => {
    expect(escapeHtml('<>"&\'')).toBe('&lt;&gt;&quot;&amp;&#39;');
  });
  test('handles null/undefined', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });
});
