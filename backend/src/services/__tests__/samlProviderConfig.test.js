/**
 * SAML provider configuration: what is stored, what is returned, and what is
 * scoped to one org.
 *
 * The rule from CLAUDE.md is that every stored third-party secret is
 * encrypted at rest with utils/crypto.js and never returned by a list/get
 * API. For SAML that is two values — the IdP's signing certificate and our SP
 * private key — and the tests below check both halves of the rule: that the
 * column holds ciphertext, and that no API-shaped response ever contains the
 * plaintext (or, for that matter, the ciphertext).
 *
 * Live-DB tests auto-skip when DATABASE_URL is unreachable, matching the rest
 * of this suite.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import prisma from '../../config/db.js';
import * as ssoConfigService from '../ssoConfigService.js';
import * as samlService from '../samlService.js';
import { decrypt } from '../../utils/crypto.js';
import { dbReachable, createTestOrg, cleanupOrg } from './testDbHelper.js';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'saml');
const IDP_CERT = fs.readFileSync(path.join(FIX, 'idp-cert.pem'), 'utf8');
const ATTACKER_CERT = fs.readFileSync(path.join(FIX, 'attacker-cert.pem'), 'utf8');

let orgA;
let orgB;
let skip = false;

const baseBody = (overrides = {}) => ({
  name: 'Acme SAML',
  presetId: 'saml',
  defaultRole: 'member',
  autoProvision: true,
  allowedDomains: [],
  requireVerifiedEmail: true,
  isActive: true,
  samlIdpEntryPoint: 'https://idp.example.com/sso',
  samlIdpEntityId: 'https://idp.example.com/entity',
  samlIdpCertificate: IDP_CERT,
  ...overrides,
});

beforeAll(async () => {
  skip = !(await dbReachable());
  if (skip) {
    console.warn('[skip] SAML provider config tests — DATABASE_URL unreachable');
    return;
  }
  orgA = await createTestOrg();
  orgB = await createTestOrg();
});

afterAll(async () => {
  if (orgA) await cleanupOrg(orgA.id);
  if (orgB) await cleanupOrg(orgB.id);
  await prisma.$disconnect().catch(() => {});
});

describe('creating a SAML provider', () => {
  test('stores the IdP certificate and the SP private key encrypted, and returns neither', async () => {
    if (skip) return;
    const dto = await ssoConfigService.createProvider(orgA.id, baseBody());

    const row = await prisma.ssoConfig.findUnique({ where: { id: dto.id } });
    expect(row.provider).toBe('saml');

    // Encrypted at rest — the column is a v2 envelope, not a PEM.
    expect(row.samlIdpCertEncrypted).toBeTruthy();
    expect(row.samlIdpCertEncrypted).not.toContain('BEGIN CERTIFICATE');
    expect(row.samlIdpCertEncrypted.startsWith('v2:')).toBe(true);
    expect(JSON.parse(decrypt(row.samlIdpCertEncrypted))[0]).toContain('BEGIN CERTIFICATE');

    expect(row.samlSpPrivateKeyEncrypted).toBeTruthy();
    expect(row.samlSpPrivateKeyEncrypted).not.toContain('BEGIN PRIVATE KEY');
    expect(decrypt(row.samlSpPrivateKeyEncrypted)).toContain('BEGIN PRIVATE KEY');

    // And neither leaves the building.
    const serialised = JSON.stringify(dto);
    expect(serialised).not.toContain('BEGIN PRIVATE KEY');
    expect(serialised).not.toContain(row.samlSpPrivateKeyEncrypted);
    expect(serialised).not.toContain(row.samlIdpCertEncrypted);
    expect(serialised).not.toContain(IDP_CERT.split('\n')[1]);
  });

  test('generates the SP key pair server-side — it is never uploaded', async () => {
    if (skip) return;
    const dto = await ssoConfigService.createProvider(orgA.id, baseBody({ name: 'Second' }));
    expect(dto.hasSpKey).toBe(true);
    expect(dto.samlSpCertificate).toContain('BEGIN CERTIFICATE'); // ours, public
    expect(dto.samlSpCertificateSummary.expired).toBe(false);
  });

  test('derives the ACS URL, SP EntityID and metadata URL from the row id', async () => {
    if (skip) return;
    const dto = await ssoConfigService.createProvider(orgA.id, baseBody({ name: 'Third' }));
    expect(dto.samlAcsUrl).toContain(`/api/auth/sso/saml/acs/${dto.id}`);
    expect(dto.samlMetadataUrl).toContain(`/api/auth/sso/saml/metadata/${dto.id}`);
    expect(dto.samlSpEntityId).toBe(dto.samlMetadataUrl);
    expect(dto.callbackUrl).toBe(dto.samlAcsUrl);
    const row = await prisma.ssoConfig.findUnique({ where: { id: dto.id } });
    expect(row.redirectUri).toBe(dto.samlAcsUrl);
  });

  test('summarises the IdP certificate for the UI without handing it over', async () => {
    if (skip) return;
    const dto = await ssoConfigService.createProvider(orgA.id, baseBody({ name: 'Fourth' }));
    expect(dto.idpCertificates).toHaveLength(1);
    expect(dto.idpCertificates[0].subject).toContain('shellius-test-idp');
    expect(dto.idpCertificates[0].fingerprint).toMatch(/^[0-9A-F:]+$/);
    expect(dto.idpCertificates[0]).not.toHaveProperty('pem');
  });

  test('defaults IdP-initiated sign-in to OFF', async () => {
    if (skip) return;
    const dto = await ssoConfigService.createProvider(orgA.id, baseBody({ name: 'Fifth' }));
    expect(dto.samlAllowIdpInitiated).toBe(false);
    expect(dto.samlSignatureAlgorithm).toBe('sha256');
    expect(dto.samlClockSkewSec).toBe(60);
  });

  test('refuses a certificate that is not a certificate, before writing anything', async () => {
    if (skip) return;
    const before = await prisma.ssoConfig.count({ where: { orgId: orgA.id } });
    await expect(
      ssoConfigService.createProvider(orgA.id, baseBody({ name: 'Bad', samlIdpCertificate: 'not a cert' }))
    ).rejects.toThrow();
    expect(await prisma.ssoConfig.count({ where: { orgId: orgA.id } })).toBe(before);
  });

  test('refuses a SAML provider with no entry point or EntityID', async () => {
    if (skip) return;
    await expect(
      ssoConfigService.createProvider(orgA.id, { ...baseBody(), samlIdpEntryPoint: undefined })
    ).rejects.toThrow(/samlIdpEntryPoint/);
    await expect(
      ssoConfigService.createProvider(orgA.id, { ...baseBody(), samlIdpEntityId: undefined })
    ).rejects.toThrow(/samlIdpEntityId/);
  });
});

describe('updating a SAML provider', () => {
  test('a blank certificate keeps the stored one', async () => {
    if (skip) return;
    const dto = await ssoConfigService.createProvider(orgA.id, baseBody({ name: 'Keep' }));
    const before = (await prisma.ssoConfig.findUnique({ where: { id: dto.id } })).samlIdpCertEncrypted;
    await ssoConfigService.updateProvider(orgA.id, dto.id, { allowedDomains: ['acme.com'] });
    const after = await prisma.ssoConfig.findUnique({ where: { id: dto.id } });
    expect(after.samlIdpCertEncrypted).toBe(before);
    expect(after.allowedDomains).toEqual(['acme.com']);
  });

  test('a new certificate replaces the old, and several at once are kept for rotation', async () => {
    if (skip) return;
    const dto = await ssoConfigService.createProvider(orgA.id, baseBody({ name: 'Rotate' }));
    const updated = await ssoConfigService.updateProvider(orgA.id, dto.id, {
      samlIdpCertificate: `${IDP_CERT}\n${ATTACKER_CERT}`,
    });
    expect(updated.idpCertificates).toHaveLength(2);
  });

  test('a provider cannot change protocol, in either direction', async () => {
    if (skip) return;
    const saml = await ssoConfigService.createProvider(orgA.id, baseBody({ name: 'Fixed' }));
    await expect(
      ssoConfigService.updateProvider(orgA.id, saml.id, { presetId: 'okta' })
    ).rejects.toThrow(/cannot be changed/);

    const oidc = await ssoConfigService.createProvider(orgA.id, {
      name: 'An OIDC one',
      presetId: 'generic',
      clientId: 'cid',
      clientSecret: 'secret',
      // A publicly-resolvable host: createProvider runs the SSRF guard, which
      // does a real DNS lookup and refuses anything that does not resolve.
      issuerUrl: 'https://accounts.google.com',
      defaultRole: 'member',
      autoProvision: true,
      allowedDomains: [],
      requireVerifiedEmail: true,
      isActive: true,
    });
    await expect(
      ssoConfigService.updateProvider(orgA.id, oidc.id, { presetId: 'saml' })
    ).rejects.toThrow(/cannot be changed/);
  });

  test('rotating the SP key replaces both halves and returns only the certificate', async () => {
    if (skip) return;
    const dto = await ssoConfigService.createProvider(orgA.id, baseBody({ name: 'SpRotate' }));
    const before = await prisma.ssoConfig.findUnique({ where: { id: dto.id } });
    const rotated = await ssoConfigService.rotateSamlSpKey(orgA.id, dto.id);
    const after = await prisma.ssoConfig.findUnique({ where: { id: dto.id } });
    expect(after.samlSpPrivateKeyEncrypted).not.toBe(before.samlSpPrivateKeyEncrypted);
    expect(after.samlSpCertificate).not.toBe(before.samlSpCertificate);
    expect(JSON.stringify(rotated)).not.toContain('BEGIN PRIVATE KEY');
  });
});

describe('org scoping', () => {
  test("one org cannot read, update or delete another org's SAML provider", async () => {
    if (skip) return;
    const dto = await ssoConfigService.createProvider(orgA.id, baseBody({ name: 'OrgA only' }));
    await expect(ssoConfigService.getProviderRow(orgB.id, dto.id)).rejects.toThrow(/not found/i);
    await expect(ssoConfigService.updateProvider(orgB.id, dto.id, { name: 'stolen' })).rejects.toThrow(/not found/i);
    await expect(ssoConfigService.rotateSamlSpKey(orgB.id, dto.id)).rejects.toThrow(/not found/i);
    await expect(ssoConfigService.deleteProvider(orgB.id, dto.id)).rejects.toThrow(/not found/i);
    const list = await ssoConfigService.listProviders(orgB.id);
    expect(list.map((p) => p.id)).not.toContain(dto.id);
  });

  test('two orgs get distinct ACS URLs and SP EntityIDs, so an assertion is never ambiguous', async () => {
    if (skip) return;
    const a = await ssoConfigService.createProvider(orgA.id, baseBody({ name: 'A' }));
    const b = await ssoConfigService.createProvider(orgB.id, baseBody({ name: 'B' }));
    expect(a.samlAcsUrl).not.toBe(b.samlAcsUrl);
    expect(a.samlSpEntityId).not.toBe(b.samlSpEntityId);
  });

  test('no SAML secret appears anywhere in the provider LIST response either', async () => {
    if (skip) return;
    const list = await ssoConfigService.listProviders(orgA.id);
    const serialised = JSON.stringify(list);
    expect(serialised).not.toContain('BEGIN PRIVATE KEY');
    expect(serialised).not.toContain('samlIdpCertEncrypted');
    expect(serialised).not.toContain('samlSpPrivateKeyEncrypted');
    expect(serialised).not.toContain(IDP_CERT.split('\n')[1]);
  });
});

describe('the configuration check that stands in for a connection test', () => {
  test('passes a complete config and says plainly that only a sign-in proves it', async () => {
    if (skip) return;
    const dto = await ssoConfigService.createProvider(orgA.id, baseBody({ name: 'Testable' }));
    const result = await ssoConfigService.testProvider(orgA.id, { id: dto.id });
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/sign-in/i);
    expect(result.details.acsUrl).toBe(samlService.acsUrlFor(dto.id));
  });

  test('warns loudly when IdP-initiated sign-in is on', async () => {
    if (skip) return;
    const dto = await ssoConfigService.createProvider(
      orgA.id,
      baseBody({ name: 'Unsolicited', samlAllowIdpInitiated: true })
    );
    const result = await ssoConfigService.testProvider(orgA.id, { id: dto.id });
    expect(result.ok).toBe(true);
    expect(result.details.warnings.join(' ')).toMatch(/IdP-initiated/i);
  });

  test('warns when the provider has been lowered to SHA-1', async () => {
    if (skip) return;
    const dto = await ssoConfigService.createProvider(
      orgA.id,
      baseBody({ name: 'Legacy', samlSignatureAlgorithm: 'sha1' })
    );
    const result = await ssoConfigService.testProvider(orgA.id, { id: dto.id });
    expect(result.details.warnings.join(' ')).toMatch(/SHA-1/i);
  });
});
