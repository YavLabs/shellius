import { describe, expect, it } from 'vitest';
import { computeIdpFields } from './IdpConfigPanel';
import { getProvider } from '@/config/ssoProviders';

const samlProvider = {
  id: 'prov_123',
  provider: 'saml',
  presetId: 'saml',
  callbackUrl: 'https://shellius.example.com/api/auth/sso/saml/acs/prov_123',
  samlAcsUrl: 'https://shellius.example.com/api/auth/sso/saml/acs/prov_123',
  samlMetadataUrl: 'https://shellius.example.com/api/auth/sso/saml/metadata/prov_123',
  samlSpEntityId: 'https://shellius.example.com/api/auth/sso/saml/metadata/prov_123',
  samlSpCertificateSummary: { fingerprint: 'AA:BB:CC:DD', notAfter: '2030-01-01T00:00:00Z' },
};

const byLabel = (fields, needle) => fields.find((f) => f.label.toLowerCase().includes(needle));

describe('computeIdpFields — OIDC presets are unchanged', () => {
  it('still returns the Google fields', () => {
    const fields = computeIdpFields(getProvider('google'), 'https://x.example.com/cb');
    expect(fields.map((f) => f.label)).toEqual(['Authorized JavaScript origin', 'Authorized redirect URI']);
  });

  it('still marks a callback-dependent field pending before the first save', () => {
    const fields = computeIdpFields(getProvider('generic'), '');
    expect(fields[0].pending).toBe(true);
  });
});

describe('computeIdpFields — SAML Service Provider values', () => {
  it('shows the four values an admin has to take to their IdP', () => {
    const fields = computeIdpFields(getProvider('saml'), samlProvider.callbackUrl, samlProvider);
    expect(fields).toHaveLength(4);
    expect(byLabel(fields, 'entityid').value).toBe(samlProvider.samlSpEntityId);
    expect(byLabel(fields, 'assertion consumer').value).toBe(samlProvider.samlAcsUrl);
    expect(byLabel(fields, 'metadata').value).toBe(samlProvider.samlMetadataUrl);
    expect(byLabel(fields, 'fingerprint').value).toBe('AA:BB:CC:DD');
    expect(fields.every((f) => !f.pending)).toBe(true);
  });

  it('uses the values the backend derived, not the browser origin', () => {
    // window.location.origin under vitest is http://localhost:3000; nothing
    // here may be rebuilt from it, because the Destination the ACS compares
    // against comes from the backend's configured public base URL.
    const fields = computeIdpFields(getProvider('saml'), '', samlProvider);
    for (const field of fields) expect(field.value).not.toMatch(/localhost/);
  });

  it('labels the fields the way each IdP console does', () => {
    expect(computeIdpFields(getProvider('saml-entra'), '', samlProvider).map((f) => f.label)).toContain(
      'Reply URL (Assertion Consumer Service URL)'
    );
    expect(computeIdpFields(getProvider('saml-okta'), '', samlProvider).map((f) => f.label)).toContain(
      'Audience URI (SP Entity ID)'
    );
    expect(computeIdpFields(getProvider('saml-adfs'), '', samlProvider).map((f) => f.label)).toContain(
      'Relying party identifier'
    );
  });

  it('marks everything pending on an unsaved provider', () => {
    const fields = computeIdpFields(getProvider('saml'), '', null);
    expect(fields).toHaveLength(4);
    expect(fields.every((f) => f.pending)).toBe(true);
  });

  it('renders the SAML panel for a provider whose preset id the UI does not know', () => {
    const fields = computeIdpFields({ id: 'saml-ping' }, '', samlProvider);
    expect(byLabel(fields, 'entityid').value).toBe(samlProvider.samlSpEntityId);
  });

  it('falls back to callbackUrl when samlAcsUrl is absent (both are the ACS URL)', () => {
    const { samlAcsUrl, ...withoutAcs } = samlProvider;
    expect(byLabel(computeIdpFields(getProvider('saml'), '', withoutAcs), 'assertion consumer').value).toBe(
      samlProvider.callbackUrl
    );
  });

  it('marks a missing SP certificate fingerprint pending rather than blank', () => {
    const { samlSpCertificateSummary, ...noCert } = samlProvider;
    expect(byLabel(computeIdpFields(getProvider('saml'), '', noCert), 'fingerprint').pending).toBe(true);
  });
});

describe('SAML presets', () => {
  it('are all enabled and carry setup steps', () => {
    for (const id of ['saml', 'saml-entra', 'saml-okta', 'saml-adfs']) {
      const preset = getProvider(id);
      expect(preset).toBeTruthy();
      expect(preset.disabled).toBeUndefined();
      expect(preset.protocol).toBe('saml');
      expect(preset.setupSteps.length).toBeGreaterThan(2);
      expect(preset.description).not.toMatch(/coming soon/i);
    }
  });
});
