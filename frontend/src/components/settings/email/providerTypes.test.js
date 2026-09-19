import { describe, expect, it } from 'vitest';
import { EMAIL_PROVIDER_TYPES, getEmailProviderType } from './providerTypes';
import { describeAuditEvent } from '@/lib/auditFormat';

// Keep in sync with backend/src/services/email/providers/index.js.
const BACKEND_TYPES = ['smtp', 'google', 'microsoft', 'sendgrid', 'mailgun', 'postmark', 'resend'];

// Secret config keys per backend adapter (secretFields minus server-only ones).
const BACKEND_SECRETS = {
  smtp: ['password'],
  google: ['clientSecret', 'serviceAccountJson'],
  microsoft: ['clientSecret'],
  sendgrid: ['apiKey'],
  mailgun: ['apiKey'],
  postmark: ['serverToken'],
  resend: ['apiKey'],
};

describe('email provider catalogue', () => {
  it('covers every backend provider type', () => {
    expect(EMAIL_PROVIDER_TYPES.map((t) => t.type).sort()).toEqual([...BACKEND_TYPES].sort());
  });

  it('marks exactly the backend secret fields as secret (write-only)', () => {
    for (const t of EMAIL_PROVIDER_TYPES) {
      const secrets = t.fields.filter((f) => f.secret).map((f) => f.key).sort();
      expect(secrets).toEqual([...BACKEND_SECRETS[t.type]].sort());
      for (const f of t.fields.filter((x) => x.secret)) {
        expect(['password', 'textarea']).toContain(f.kind);
      }
    }
  });

  it('API-key providers require a from address; mailbox providers do not', () => {
    expect(getEmailProviderType('resend').fromRequired).toBe(true);
    expect(getEmailProviderType('sendgrid').fromRequired).toBe(true);
    expect(getEmailProviderType('google').fromRequired).toBe(false);
    expect(getEmailProviderType('microsoft').fromRequired).toBe(false);
  });

  it('Google shows OAuth or service-account fields by mode', () => {
    const g = getEmailProviderType('google');
    const visible = (mode) => g.fields.filter((f) => !f.showIf || f.showIf({ mode })).map((f) => f.key);
    expect(visible('oauth')).toEqual(['mode', 'clientId', 'clientSecret']);
    expect(visible('service_account')).toEqual(['mode', 'serviceAccountJson', 'delegatedUser']);
  });

  it('Microsoft help names the Graph permission to grant', () => {
    expect(getEmailProviderType('microsoft').help).toMatch(/Mail\.Send/);
    expect(getEmailProviderType('google').help).toMatch(/gmail\.send/);
  });
});

describe('email provider audit events', () => {
  it('read naturally', () => {
    expect(describeAuditEvent({ action: 'email_provider.activate', metadata: { name: 'Gmail' } })).toMatchObject({
      verb: 'activated',
      object: 'email provider',
      target: 'Gmail',
    });
    expect(describeAuditEvent({ action: 'email_provider.test', metadata: { name: 'SMTP' } }).verb).toBe('tested');
  });
});
