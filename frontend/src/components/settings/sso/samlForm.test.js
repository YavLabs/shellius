import { describe, expect, it } from 'vitest';
import {
  ATTRIBUTE_MAPPING_KEYS,
  MAX_CERT_CHARS,
  buildSamlFields,
  certificateStatus,
  cleanAttributeMapping,
  inspectCertificateInput,
  isSamlPreset,
  isSamlProvider,
  nameIdFormatOptions,
  normalizeCertificateText,
  parseClockSkew,
  samlAdvisories,
  samlStateFromProvider,
  shortFingerprint,
  signatureAlgorithmOptions,
  validateEntityId,
  validateEntryPoint,
  validateIdentifierFormat,
  validateSamlForm,
} from './samlForm';

// A body long enough to clear the backend's 100-character floor. Not a real
// certificate — nothing on the client parses X.509.
const B64 = 'MIIDdzCCAl+gAwIBAgIEbGFtZTANBgkqhkiG9w0BAQsFADBsMQswCQYDVQQGEwJVUzETMBEGA1UE'.repeat(3);
const PEM = `-----BEGIN CERTIFICATE-----\n${B64}\n-----END CERTIFICATE-----`;

const TRANSIENT = 'urn:oasis:names:tc:SAML:2.0:nameid-format:transient';

function baseState(overrides = {}) {
  return {
    idpEntryPoint: 'https://idp.example.com/sso',
    idpEntityId: 'https://idp.example.com/entity',
    idpCertificate: PEM,
    spEntityIdOverride: '',
    signatureAlgorithm: 'sha256',
    wantAuthnResponseSigned: false,
    allowIdpInitiated: false,
    clockSkewSec: '60',
    identifierFormat: '',
    forceAuthn: false,
    signRequests: true,
    attributeMapping: {},
    ...overrides,
  };
}

describe('isSamlPreset / isSamlProvider', () => {
  it('matches the backend SAML_PRESET_IDS list', () => {
    expect(['saml', 'saml-entra', 'saml-okta', 'saml-adfs'].every(isSamlPreset)).toBe(true);
    expect(isSamlPreset('generic')).toBe(false);
    expect(isSamlPreset(undefined)).toBe(false);
  });

  it('trusts the saved provider protocol over the preset', () => {
    // A provider created through the API with a preset id this build does not
    // know still has to render the SAML form.
    expect(isSamlProvider({ id: 'saml-ping', protocol: undefined }, { provider: 'saml' })).toBe(true);
    // And an OIDC row never renders as SAML even if a stale preset says so.
    expect(isSamlProvider({ id: 'saml', protocol: 'saml' }, { provider: 'oidc' })).toBe(false);
  });

  it('falls back to the preset when creating', () => {
    expect(isSamlProvider({ id: 'saml-okta', protocol: 'saml' }, null)).toBe(true);
    expect(isSamlProvider({ id: 'google', protocol: 'oidc' }, null)).toBe(false);
    expect(isSamlProvider(null, null)).toBe(false);
  });
});

describe('normalizeCertificateText', () => {
  it('converts CRLF and lone CR to LF and trims', () => {
    const windowsPaste = `\r\n-----BEGIN CERTIFICATE-----\r\n${B64}\r\n-----END CERTIFICATE-----\r\n   `;
    expect(normalizeCertificateText(windowsPaste)).toBe(PEM);
    expect(normalizeCertificateText('a\rb')).toBe('a\nb');
  });

  it('is total on non-strings', () => {
    expect(normalizeCertificateText(undefined)).toBe('');
    expect(normalizeCertificateText(null)).toBe('');
    expect(normalizeCertificateText(42)).toBe('');
  });
});

describe('inspectCertificateInput', () => {
  it('accepts a single PEM block', () => {
    expect(inspectCertificateInput(PEM)).toMatchObject({ empty: false, count: 1, error: null });
  });

  it('accepts a PEM with Windows line endings and trailing whitespace', () => {
    const r = inspectCertificateInput(`${PEM.replace(/\n/g, '\r\n')}\r\n\t  `);
    expect(r.error).toBeNull();
    expect(r.count).toBe(1);
    expect(r.text.endsWith('-----END CERTIFICATE-----')).toBe(true);
  });

  it('accepts bare base64 with no headers (what Okta and Entra show)', () => {
    expect(inspectCertificateInput(B64)).toMatchObject({ count: 1, error: null });
  });

  it('accepts bare base64 wrapped across lines', () => {
    expect(inspectCertificateInput(B64.replace(/(.{40})/g, '$1\n'))).toMatchObject({ count: 1, error: null });
  });

  it('counts several PEM blocks (staged rotation)', () => {
    expect(inspectCertificateInput(`${PEM}\n${PEM}\n${PEM}`).count).toBe(3);
  });

  it('ignores prose around the blocks, as the backend regex does', () => {
    const r = inspectCertificateInput(`Signing certificate:\n${PEM}\nDownloaded 2026-01-01`);
    expect(r).toMatchObject({ count: 1, error: null });
  });

  it('rejects more than five certificates', () => {
    const r = inspectCertificateInput(Array(6).fill(PEM).join('\n'));
    expect(r.count).toBe(6);
    expect(r.error).toMatch(/At most 5/);
  });

  it('rejects an incomplete PEM block', () => {
    expect(inspectCertificateInput(`-----BEGIN CERTIFICATE-----\n${B64}`).error).toMatch(/Incomplete PEM/);
    expect(inspectCertificateInput(`${B64}\n-----END CERTIFICATE-----`).error).toMatch(/Incomplete PEM/);
  });

  it('rejects a private key paste by name, not by luck', () => {
    const key = `-----BEGIN PRIVATE KEY-----\n${B64}\n-----END PRIVATE KEY-----`;
    expect(inspectCertificateInput(key).error).toMatch(/private key/i);
    const rsaKey = `-----BEGIN RSA PRIVATE KEY-----\n${B64}\n-----END RSA PRIVATE KEY-----`;
    expect(inspectCertificateInput(rsaKey).error).toMatch(/private key/i);
  });

  it('rejects non-base64 junk', () => {
    expect(inspectCertificateInput('not a certificate at all!!').error).toMatch(/Not valid PEM or base64/);
  });

  it('rejects base64 that is too short to be a certificate', () => {
    expect(inspectCertificateInput('QUJDREVG').error).toMatch(/Too short/);
  });

  it('rejects a certificate beyond the backend size cap', () => {
    const huge = 'A'.repeat(MAX_CERT_CHARS + 1);
    expect(inspectCertificateInput(huge).error).toMatch(/too long/);
  });

  it('accepts a very long but in-bounds certificate chain', () => {
    const long = 'A'.repeat(MAX_CERT_CHARS - 10);
    expect(inspectCertificateInput(long)).toMatchObject({ count: 1, error: null });
  });

  it('treats blank and whitespace-only input as empty, not as an error', () => {
    expect(inspectCertificateInput('')).toMatchObject({ empty: true, error: null });
    expect(inspectCertificateInput('   \r\n\t ')).toMatchObject({ empty: true, error: null });
    expect(inspectCertificateInput(undefined)).toMatchObject({ empty: true, error: null });
  });
});

describe('parseClockSkew', () => {
  it('omits the field when blank', () => {
    expect(parseClockSkew('')).toEqual({ value: null, error: null });
    expect(parseClockSkew(undefined)).toEqual({ value: null, error: null });
  });

  it('accepts the documented range inclusively', () => {
    expect(parseClockSkew('0').value).toBe(0);
    expect(parseClockSkew('300').value).toBe(300);
    expect(parseClockSkew(60).value).toBe(60);
  });

  it('rejects out-of-range values', () => {
    expect(parseClockSkew('301').error).toMatch(/between 0 and 300/);
    expect(parseClockSkew('-1').error).toBeTruthy();
    expect(parseClockSkew('99999').error).toBeTruthy();
  });

  it('rejects non-integers', () => {
    expect(parseClockSkew('1.5').error).toMatch(/whole number/);
    expect(parseClockSkew('abc').error).toMatch(/whole number/);
    expect(parseClockSkew('60s').error).toMatch(/whole number/);
    expect(parseClockSkew('1e2').error).toMatch(/whole number/);
  });
});

describe('validateEntryPoint', () => {
  it('requires an absolute http(s) URL', () => {
    expect(validateEntryPoint('https://idp.example.com/sso')).toBeNull();
    expect(validateEntryPoint('http://localhost:8080/sso')).toBeNull();
    expect(validateEntryPoint('')).toMatch(/required/);
    expect(validateEntryPoint('idp.example.com/sso')).toMatch(/absolute URL/);
    expect(validateEntryPoint('javascript:alert(1)')).toMatch(/must use https/);
    expect(validateEntryPoint('ftp://idp.example.com')).toMatch(/must use https/);
  });

  it('enforces the 2000-character bound', () => {
    expect(validateEntryPoint(`https://idp.example.com/${'a'.repeat(2000)}`)).toMatch(/too long/);
  });
});

describe('validateEntityId', () => {
  it('accepts a URN or a URL, and requires a value by default', () => {
    expect(validateEntityId('urn:example:idp')).toBeNull();
    expect(validateEntityId('http://adfs.example.com/adfs/services/trust')).toBeNull();
    expect(validateEntityId('  ')).toMatch(/required/);
  });

  it('can be optional, and bounds the length', () => {
    expect(validateEntityId('', { required: false })).toBeNull();
    expect(validateEntityId('x'.repeat(1025), { required: false, label: 'Service Provider EntityID' })).toMatch(
      /Service Provider EntityID is too long/
    );
  });
});

describe('validateIdentifierFormat', () => {
  it('allows blank and bounds the length', () => {
    expect(validateIdentifierFormat('')).toBeNull();
    expect(validateIdentifierFormat(TRANSIENT)).toBeNull();
    expect(validateIdentifierFormat('x'.repeat(201))).toMatch(/too long/);
  });
});

describe('cleanAttributeMapping', () => {
  it('drops keys the backend does not define', () => {
    const r = cleanAttributeMapping({ email: 'mail', department: 'dept', role: 'r' });
    expect(r.value).toEqual({ email: 'mail' });
    expect(r.dropped.sort()).toEqual(['department', 'role']);
  });

  it('trims values and drops blanks', () => {
    expect(cleanAttributeMapping({ email: '  mail  ', name: '   ' }).value).toEqual({ email: 'mail' });
  });

  it('returns null when nothing is mapped, which clears the stored mapping', () => {
    expect(cleanAttributeMapping({}).value).toBeNull();
    expect(cleanAttributeMapping({ email: '', groups: '' }).value).toBeNull();
    expect(cleanAttributeMapping(null).value).toBeNull();
    expect(cleanAttributeMapping('nonsense').value).toBeNull();
    expect(cleanAttributeMapping(['email']).value).toBeNull();
  });

  it('rejects an attribute name beyond the backend bound', () => {
    expect(cleanAttributeMapping({ email: 'x'.repeat(301) }).error).toMatch(/too long/);
  });

  it('ignores non-string values rather than sending them', () => {
    expect(cleanAttributeMapping({ email: 123, groups: ['a'] }).value).toBeNull();
  });
});

describe('samlStateFromProvider', () => {
  it('never prefills the certificate, because the DTO never returns one', () => {
    const state = samlStateFromProvider({ hasIdpCertificate: true, samlIdpEntityId: 'urn:x' });
    expect(state.idpCertificate).toBe('');
    expect(state.idpEntityId).toBe('urn:x');
  });

  it('leaves the SP EntityID override blank when it equals the derived default', () => {
    const provider = {
      samlMetadataUrl: 'https://shellius.example.com/api/auth/sso/saml/metadata/abc',
      samlSpEntityId: 'https://shellius.example.com/api/auth/sso/saml/metadata/abc',
    };
    expect(samlStateFromProvider(provider).spEntityIdOverride).toBe('');
  });

  it('keeps a genuine SP EntityID override', () => {
    const provider = {
      samlMetadataUrl: 'https://shellius.example.com/api/auth/sso/saml/metadata/abc',
      samlSpEntityId: 'urn:acme:shellius',
    };
    expect(samlStateFromProvider(provider).spEntityIdOverride).toBe('urn:acme:shellius');
  });

  it('defaults booleans the way the backend columns do', () => {
    const state = samlStateFromProvider({});
    expect(state.signRequests).toBe(true); // column default true
    expect(state.forceAuthn).toBe(false);
    expect(state.allowIdpInitiated).toBe(false);
    expect(state.wantAuthnResponseSigned).toBe(false);
    expect(state.clockSkewSec).toBe('60');
    expect(state.signatureAlgorithm).toBe('sha256');
  });

  it('accepts a zero clock skew instead of treating it as unset', () => {
    expect(samlStateFromProvider({ samlClockSkewSec: 0 }).clockSkewSec).toBe('0');
  });

  it('survives a garbage attribute mapping written outside the UI', () => {
    const state = samlStateFromProvider({ samlAttributeMapping: ['email'] });
    expect(Object.keys(state.attributeMapping).sort()).toEqual([...ATTRIBUTE_MAPPING_KEYS].sort());
    expect(Object.values(state.attributeMapping).every((v) => v === '')).toBe(true);
  });

  it('keeps only the known keys from a mapping that has extras', () => {
    const state = samlStateFromProvider({ samlAttributeMapping: { email: 'mail', department: 'dept' } });
    expect(state.attributeMapping.email).toBe('mail');
    expect(state.attributeMapping.department).toBeUndefined();
  });

  it('is safe on null (the create path)', () => {
    expect(samlStateFromProvider(null).idpEntryPoint).toBe('');
  });
});

describe('validateSamlForm', () => {
  it('passes on a complete new provider', () => {
    expect(validateSamlForm(baseState())).toEqual({ valid: true, errors: {} });
  });

  it('requires a certificate when creating', () => {
    const r = validateSamlForm(baseState({ idpCertificate: '' }));
    expect(r.valid).toBe(false);
    expect(r.errors.idpCertificate).toMatch(/required/);
  });

  it('allows a blank certificate when one is already stored', () => {
    const r = validateSamlForm(baseState({ idpCertificate: '' }), { hasStoredCertificate: true });
    expect(r.valid).toBe(true);
  });

  it('still rejects a BAD certificate when one is stored', () => {
    const r = validateSamlForm(baseState({ idpCertificate: 'oops!' }), { hasStoredCertificate: true });
    expect(r.errors.idpCertificate).toBeTruthy();
  });

  it('reports every bad field at once', () => {
    const r = validateSamlForm(
      baseState({ idpEntryPoint: 'nope', idpEntityId: '', clockSkewSec: '900', identifierFormat: 'x'.repeat(201) })
    );
    expect(Object.keys(r.errors).sort()).toEqual(['clockSkewSec', 'identifierFormat', 'idpEntityId', 'idpEntryPoint']);
  });

  it('is total on an empty state object', () => {
    expect(validateSamlForm(undefined).valid).toBe(false);
  });
});

describe('buildSamlFields', () => {
  it('sends only keys the backend samlFields schema accepts', () => {
    const allowed = new Set([
      'samlIdpEntryPoint',
      'samlIdpEntityId',
      'samlIdpCertificate',
      'samlSpEntityId',
      'samlSignatureAlgorithm',
      'samlWantAuthnResponseSigned',
      'samlAllowIdpInitiated',
      'samlClockSkewSec',
      'samlIdentifierFormat',
      'samlForceAuthn',
      'samlSignRequests',
      'samlAttributeMapping',
    ]);
    const body = buildSamlFields(baseState({ spEntityIdOverride: 'urn:x', identifierFormat: 'urn:f', attributeMapping: { email: 'mail' } }), { isEdit: true });
    for (const key of Object.keys(body)) expect(allowed.has(key)).toBe(true);
  });

  it('never sends OIDC fields', () => {
    const body = buildSamlFields(baseState());
    expect(body.clientId).toBeUndefined();
    expect(body.clientSecret).toBeUndefined();
    expect(body.issuerUrl).toBeUndefined();
    expect(body.scopes).toBeUndefined();
  });

  it('omits a blank certificate on edit so the stored one survives', () => {
    const body = buildSamlFields(baseState({ idpCertificate: '   ' }), { isEdit: true });
    expect('samlIdpCertificate' in body).toBe(false);
  });

  it('omits an INVALID certificate rather than sending garbage', () => {
    // validateSamlForm blocks the save; this is belt and braces so a bad
    // value can never reach the wire and blank a good stored certificate.
    const body = buildSamlFields(baseState({ idpCertificate: 'junk' }), { isEdit: true });
    expect('samlIdpCertificate' in body).toBe(false);
  });

  it('normalises CRLF before sending the certificate', () => {
    const body = buildSamlFields(baseState({ idpCertificate: PEM.replace(/\n/g, '\r\n') }));
    expect(body.samlIdpCertificate).toBe(PEM);
    expect(body.samlIdpCertificate).not.toMatch(/\r/);
  });

  it('sends several PEMs as one string, as the backend expects', () => {
    const body = buildSamlFields(baseState({ idpCertificate: `${PEM}\n${PEM}` }));
    expect(body.samlIdpCertificate.match(/BEGIN CERTIFICATE/g)).toHaveLength(2);
  });

  it('omits the clock skew when blank, so the backend default applies', () => {
    expect('samlClockSkewSec' in buildSamlFields(baseState({ clockSkewSec: '' }))).toBe(false);
  });

  it('omits an out-of-range clock skew instead of sending a 400', () => {
    expect('samlClockSkewSec' in buildSamlFields(baseState({ clockSkewSec: '400' }))).toBe(false);
  });

  it('sends a zero clock skew', () => {
    expect(buildSamlFields(baseState({ clockSkewSec: '0' })).samlClockSkewSec).toBe(0);
  });

  it('omits optional blanks on create but clears them on edit', () => {
    const created = buildSamlFields(baseState());
    expect('samlSpEntityId' in created).toBe(false);
    expect('samlIdentifierFormat' in created).toBe(false);
    expect('samlAttributeMapping' in created).toBe(false);

    const edited = buildSamlFields(baseState(), { isEdit: true });
    expect(edited.samlSpEntityId).toBe('');
    expect(edited.samlIdentifierFormat).toBe('');
    expect(edited.samlAttributeMapping).toBeNull();
  });

  it('strips unknown attribute-mapping keys', () => {
    const body = buildSamlFields(baseState({ attributeMapping: { email: 'mail', department: 'dept' } }));
    expect(body.samlAttributeMapping).toEqual({ email: 'mail' });
  });

  it('trims the identifiers', () => {
    const body = buildSamlFields(baseState({ idpEntryPoint: '  https://idp.example.com/sso  ', idpEntityId: ' urn:x ' }));
    expect(body.samlIdpEntryPoint).toBe('https://idp.example.com/sso');
    expect(body.samlIdpEntityId).toBe('urn:x');
  });

  it('always sends the booleans, so turning one off actually turns it off', () => {
    const body = buildSamlFields(baseState({ signRequests: false, forceAuthn: false, allowIdpInitiated: false }), { isEdit: true });
    expect(body.samlSignRequests).toBe(false);
    expect(body.samlForceAuthn).toBe(false);
    expect(body.samlAllowIdpInitiated).toBe(false);
    expect(body.samlWantAuthnResponseSigned).toBe(false);
  });
});

describe('option lists', () => {
  it('does not offer a transient NameID, which the ACS refuses', () => {
    expect(nameIdFormatOptions('').some((o) => o.value === TRANSIENT)).toBe(false);
  });

  it('shows a stored value the UI does not know instead of rewriting it', () => {
    const opts = nameIdFormatOptions('urn:example:custom');
    expect(opts.some((o) => o.value === 'urn:example:custom')).toBe(true);
    expect(nameIdFormatOptions(TRANSIENT).find((o) => o.value === TRANSIENT).label).toMatch(/refused/);
  });

  it('shows a stored signature algorithm outside the accepted three', () => {
    // sha384 is a strength samlService understands but the API will not set.
    expect(signatureAlgorithmOptions('sha384').some((o) => o.value === 'sha384')).toBe(true);
    expect(signatureAlgorithmOptions('sha256')).toHaveLength(3);
  });
});

describe('certificateStatus', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');

  it('flags an expired certificate', () => {
    expect(certificateStatus({ notAfter: '2025-12-01T00:00:00Z', expired: true }, now).tone).toBe('danger');
  });

  it('warns within 30 days', () => {
    expect(certificateStatus({ notAfter: '2026-01-20T00:00:00Z' }, now)).toMatchObject({ tone: 'warning' });
  });

  it('is happy further out', () => {
    expect(certificateStatus({ notAfter: '2027-01-01T00:00:00Z' }, now).tone).toBe('success');
  });

  it('survives a missing or unparseable summary', () => {
    expect(certificateStatus(null, now).label).toBe('Unreadable');
    expect(certificateStatus({ notAfter: 'not a date' }, now).label).toBe('Unknown expiry');
  });
});

describe('shortFingerprint', () => {
  it('elides the middle of a SHA-256 fingerprint', () => {
    const fp = Array.from({ length: 32 }, (_, i) => i.toString(16).padStart(2, '0').toUpperCase()).join(':');
    const short = shortFingerprint(fp);
    expect(short.startsWith('00:01:02:03')).toBe(true);
    expect(short.endsWith('1C:1D:1E:1F')).toBe(true);
  });

  it('leaves short or missing values alone', () => {
    expect(shortFingerprint('AB:CD')).toBe('AB:CD');
    expect(shortFingerprint(null)).toBe('');
  });
});

describe('samlAdvisories', () => {
  it('says nothing about a stock configuration', () => {
    expect(samlAdvisories(baseState(), { provider: 'saml', hasSpKey: true })).toEqual([]);
  });

  it('warns about IdP-initiated sign-in and explains why', () => {
    const [advisory] = samlAdvisories(baseState({ allowIdpInitiated: true }), null);
    expect(advisory.level).toBe('warning');
    expect(advisory.message).toMatch(/InResponseTo/);
  });

  it('warns about a SHA-1 floor', () => {
    expect(samlAdvisories(baseState({ signatureAlgorithm: 'sha1' }), null)[0].message).toMatch(/SHA-1/);
  });

  it('errors on a transient NameID format', () => {
    expect(samlAdvisories(baseState({ identifierFormat: TRANSIENT }), null)[0].level).toBe('error');
  });

  it('notes unsigned AuthnRequests', () => {
    expect(samlAdvisories(baseState({ signRequests: false }), null)[0].message).toMatch(/unsigned/);
  });

  it('warns when the provider has no SP key pair', () => {
    const out = samlAdvisories(baseState(), { provider: 'saml', hasSpKey: false });
    expect(out.some((a) => /Service Provider key pair/.test(a.message))).toBe(true);
  });

  it('errors when a stored certificate cannot be decrypted', () => {
    const out = samlAdvisories(baseState(), { provider: 'saml', hasSpKey: true, hasIdpCertificate: true, idpCertificates: [] });
    expect(out.some((a) => a.level === 'error' && /encryption key/.test(a.message))).toBe(true);
  });
});
