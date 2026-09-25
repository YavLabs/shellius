import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import ProviderForm from './ProviderForm';
import { getProvider } from '@/config/ssoProviders';

const createSsoProvider = vi.fn();
const updateSsoProvider = vi.fn();
const testSavedSsoProvider = vi.fn();
const testDraftSsoProvider = vi.fn();
const rotateSamlSpKey = vi.fn();

vi.mock('@/services/ssoConfigService', () => ({
  createSsoProvider: (...args) => createSsoProvider(...args),
  updateSsoProvider: (...args) => updateSsoProvider(...args),
  testSavedSsoProvider: (...args) => testSavedSsoProvider(...args),
  testDraftSsoProvider: (...args) => testDraftSsoProvider(...args),
  rotateSamlSpKey: (...args) => rotateSamlSpKey(...args),
}));

vi.mock('@/services/roleService', () => ({
  listRoles: () => Promise.resolve([{ key: 'member', name: 'Member', locked: false, sensitivePermissions: [] }]),
}));

const B64 = 'MIIDdzCCAl+gAwIBAgIEbGFtZTANBgkqhkiG9w0BAQsFADBsMQswCQYDVQQGEwJVUzETMBEGA1UE'.repeat(3);
const PEM = `-----BEGIN CERTIFICATE-----\n${B64}\n-----END CERTIFICATE-----`;

const savedSamlProvider = {
  id: 'prov_1',
  name: 'Corp SAML',
  provider: 'saml',
  presetId: 'saml',
  isActive: true,
  defaultRole: 'member',
  autoProvision: true,
  allowedDomains: [],
  requireVerifiedEmail: true,
  hasIdpCertificate: true,
  hasSpKey: true,
  idpCertificates: [{ subject: 'CN=idp', notAfter: '2030-01-01T00:00:00Z', fingerprint: 'AA:BB', expired: false }],
  samlIdpEntryPoint: 'https://idp.example.com/sso',
  samlIdpEntityId: 'urn:idp',
  samlAcsUrl: 'https://shellius.example.com/api/auth/sso/saml/acs/prov_1',
  samlMetadataUrl: 'https://shellius.example.com/api/auth/sso/saml/metadata/prov_1',
  samlSpEntityId: 'https://shellius.example.com/api/auth/sso/saml/metadata/prov_1',
  samlSpCertificateSummary: { fingerprint: 'CC:DD', notAfter: '2031-01-01T00:00:00Z' },
  samlSignatureAlgorithm: 'sha256',
  samlClockSkewSec: 60,
  samlSignRequests: true,
  callbackUrl: 'https://shellius.example.com/api/auth/sso/saml/acs/prov_1',
};

beforeEach(() => {
  vi.clearAllMocks();
});

/**
 * Render and let the role list (fetched on mount) settle, so React's act()
 * warning does not fire for a state update the test does not care about.
 */
async function renderForm(ui) {
  const result = render(ui);
  await act(async () => {});
  return result;
}

describe('ProviderForm — SAML branch', () => {
  it('renders SAML fields and no OIDC client credentials', async () => {
    await renderForm(<ProviderForm preset={getProvider('saml')} orgGroups={[]} onSaved={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByLabelText(/IdP sign-in URL/)).toBeInTheDocument();
    expect(screen.getByLabelText(/IdP EntityID/)).toBeInTheDocument();
    expect(screen.getByLabelText(/IdP signing certificate/)).toBeInTheDocument();
    expect(screen.queryByText('Client ID')).not.toBeInTheDocument();
    expect(screen.queryByText('Client Secret')).not.toBeInTheDocument();
  });

  it('will not let a draft be "tested" — the backend refuses an unsaved SAML test', async () => {
    await renderForm(<ProviderForm preset={getProvider('saml')} orgGroups={[]} onSaved={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByRole('button', { name: /Check configuration/ })).toBeDisabled();
    expect(testDraftSsoProvider).not.toHaveBeenCalled();
  });

  it('creates with the SAML body and keeps the dialog open for the SP values', async () => {
    createSsoProvider.mockResolvedValue(savedSamlProvider);
    const onSaved = vi.fn();
    await renderForm(<ProviderForm preset={getProvider('saml')} orgGroups={[]} onSaved={onSaved} onCancel={vi.fn()} />);

    fireEvent.change(screen.getByLabelText(/IdP sign-in URL/), { target: { value: 'https://idp.example.com/sso' } });
    fireEvent.change(screen.getByLabelText(/IdP EntityID/), { target: { value: 'urn:idp' } });
    fireEvent.change(screen.getByLabelText(/IdP signing certificate/), { target: { value: PEM } });
    fireEvent.click(screen.getByRole('button', { name: 'Add provider' }));

    await waitFor(() => expect(createSsoProvider).toHaveBeenCalledTimes(1));
    const body = createSsoProvider.mock.calls[0][0];
    expect(body.presetId).toBe('saml');
    expect(body.samlIdpEntryPoint).toBe('https://idp.example.com/sso');
    expect(body.samlIdpCertificate).toContain('BEGIN CERTIFICATE');
    expect('clientId' in body).toBe(false);
    expect('clientSecret' in body).toBe(false);
    expect('issuerUrl' in body).toBe(false);

    // Stays open so the derived ACS URL / EntityID / metadata URL can be copied.
    expect(onSaved).not.toHaveBeenCalled();
    await screen.findByText(/Provider created/);
    expect(screen.getByDisplayValue(savedSamlProvider.samlAcsUrl)).toBeInTheDocument();
  });

  it('refuses to save an invalid certificate and does not call the API', async () => {
    await renderForm(<ProviderForm preset={getProvider('saml')} orgGroups={[]} onSaved={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/IdP sign-in URL/), { target: { value: 'https://idp.example.com/sso' } });
    fireEvent.change(screen.getByLabelText(/IdP EntityID/), { target: { value: 'urn:idp' } });
    fireEvent.change(screen.getByLabelText(/IdP signing certificate/), { target: { value: 'not a certificate!' } });
    expect(await screen.findByText(/Not valid PEM or base64/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add provider' })).toBeDisabled();
    expect(createSsoProvider).not.toHaveBeenCalled();
  });

  it('keeps a stored certificate when the box is left blank', async () => {
    updateSsoProvider.mockResolvedValue(savedSamlProvider);
    await renderForm(
      <ProviderForm
        preset={getProvider('saml')}
        existingProvider={savedSamlProvider}
        orgGroups={[]}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    const box = screen.getByLabelText(/IdP signing certificate/);
    expect(box).toHaveValue('');
    expect(box.placeholder).toMatch(/leave blank to keep/i);

    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(updateSsoProvider).toHaveBeenCalledTimes(1));
    const [id, body] = updateSsoProvider.mock.calls[0];
    expect(id).toBe('prov_1');
    expect('samlIdpCertificate' in body).toBe(false);
  });

  it('renders a SAML row whose preset id this build does not know', async () => {
    const unknown = { ...savedSamlProvider, presetId: 'saml-ping' };
    // What SsoTab hands down when getProvider() misses.
    const fallbackPreset = { id: 'saml-ping', label: unknown.name, fields: ['clientId', 'clientSecret'], protocol: 'saml' };
    await renderForm(
      <ProviderForm preset={fallbackPreset} existingProvider={unknown} orgGroups={[]} onSaved={vi.fn()} onCancel={vi.fn()} />
    );
    expect(screen.getByLabelText(/IdP sign-in URL/)).toBeInTheDocument();
    expect(screen.queryByText('Client ID')).not.toBeInTheDocument();
  });

  it('rotating the SP key asks for confirmation and warns about re-importing metadata', async () => {
    rotateSamlSpKey.mockResolvedValue({ ...savedSamlProvider, samlSpCertificateSummary: { fingerprint: 'EE:FF', notAfter: '2032-01-01T00:00:00Z' } });
    await renderForm(
      <ProviderForm
        preset={getProvider('saml')}
        existingProvider={savedSamlProvider}
        orgGroups={[]}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /Rotate key/ }));
    expect(screen.getByText(/destroys the current private key/i)).toBeInTheDocument();
    expect(rotateSamlSpKey).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Rotate now' }));
    await waitFor(() => expect(rotateSamlSpKey).toHaveBeenCalledWith('prov_1'));
  });

  it('warns about IdP-initiated sign-in when it is switched on', async () => {
    await renderForm(
      <ProviderForm
        preset={getProvider('saml')}
        existingProvider={{ ...savedSamlProvider, samlAllowIdpInitiated: true }}
        orgGroups={[]}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    expect(screen.getByText(/no InResponseTo/)).toBeInTheDocument();
  });
});

describe('ProviderForm — OIDC branch is untouched', () => {
  it('still asks for a client id and secret', async () => {
    await renderForm(<ProviderForm preset={getProvider('google')} orgGroups={[]} onSaved={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByText('Client ID')).toBeInTheDocument();
    expect(screen.getByText('Client Secret')).toBeInTheDocument();
    expect(screen.queryByLabelText(/IdP sign-in URL/)).not.toBeInTheDocument();
  });

  it('keeps a stored client secret when the field is left blank', async () => {
    updateSsoProvider.mockResolvedValue({ id: 'g1' });
    await renderForm(
      <ProviderForm
        preset={getProvider('google')}
        existingProvider={{
          id: 'g1',
          name: 'Google',
          provider: 'oidc',
          presetId: 'google',
          clientId: 'abc',
          hasClientSecret: true,
          isActive: true,
          defaultRole: 'member',
          autoProvision: true,
          allowedDomains: [],
          requireVerifiedEmail: true,
        }}
        orgGroups={[]}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(updateSsoProvider).toHaveBeenCalledTimes(1));
    expect('clientSecret' in updateSsoProvider.mock.calls[0][1]).toBe(false);
  });
});
