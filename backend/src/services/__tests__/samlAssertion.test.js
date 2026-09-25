/**
 * samlService.consumeAssertion — every way a SAML assertion can be wrong.
 *
 * A SAML assertion is a bearer credential that arrives in a cross-site form
 * POST from the user's own browser. Nothing about the channel is trustworthy,
 * so everything below is a test of a REFUSAL. The single positive test exists
 * to prove the refusals are not vacuous.
 *
 * The corpus is fixed and committed (fixtures/saml/, built by
 * scripts/generate-saml-fixtures.mjs with a throwaway key). Signing the input
 * inside the test would only prove that the verifier agrees with the signer;
 * fixed bytes can prove it refuses a document the test cannot adjust.
 *
 * Time is pinned with jest fake timers — Date only, timers left real so the
 * replay store's own deadline still works — so a fixture that passes today
 * passes in five years.
 *
 * No database and no Redis: the replay store is INJECTED (this repo's jest
 * ESM setup makes unstable_mockModule unreliable — see caService.test.js).
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { jest } from '@jest/globals';
import * as samlService from '../samlService.js';
import { SamlReplayStoreUnavailable } from '../saml/samlReplayStore.js';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'saml');
const read = (f) => fs.readFileSync(path.join(FIX, f), 'utf8');
const K = JSON.parse(read('constants.json'));

const IDP_CERT = read('idp-cert.pem');
const ATTACKER_CERT = read('attacker-cert.pem');

const b64 = (f) => Buffer.from(read(f), 'utf8').toString('base64');

// --- an in-memory replay store with the same contract as the Redis one -----
function memoryStore() {
  const requests = new Map();
  const assertions = new Map();
  const store = {
    createCacheProvider: () => ({
      async saveAsync(key, value) {
        requests.set(key, value);
        return { value, createdAt: Date.now() };
      },
      async getAsync(key) {
        return requests.has(key) ? requests.get(key) : null;
      },
      async removeAsync(key) {
        requests.delete(key);
        return key;
      },
    }),
    async claimAssertionId(providerId, assertionId) {
      const k = `${providerId}:${assertionId}`;
      if (assertions.has(k)) return false;
      assertions.set(k, 1);
      return true;
    },
    _requests: requests,
    _assertions: assertions,
  };
  // Pre-arm the AuthnRequest id the fixtures claim to answer.
  requests.set(K.REQUEST_ID, new Date(K.ISSUE_INSTANT).toISOString());
  return store;
}

/** A store that behaves exactly as the Redis one does when Redis is down. */
function brokenStore() {
  return {
    createCacheProvider: () => ({
      async saveAsync() {
        throw new SamlReplayStoreUnavailable('saveRequestId');
      },
      async getAsync() {
        throw new SamlReplayStoreUnavailable('getRequestId');
      },
      async removeAsync() {
        return null;
      },
    }),
    async claimAssertionId() {
      throw new SamlReplayStoreUnavailable('claimAssertionId');
    },
  };
}

function makeCfg(overrides = {}) {
  return {
    id: 'prov_aaa',
    orgId: 'org_1',
    provider: 'saml',
    presetId: 'saml',
    idpCerts: [IDP_CERT],
    spPrivateKey: null,
    spCertificate: null,
    spEntityId: K.SP_ENTITY_ID,
    acsUrl: K.ACS_URL,
    samlIdpEntryPoint: 'https://idp.test/sso',
    samlIdpEntityId: K.IDP_ENTITY_ID,
    samlSignRequests: false,
    samlWantAuthnResponseSigned: false,
    samlAllowIdpInitiated: false,
    samlSignatureAlgorithm: 'sha256',
    clockSkewSec: 60,
    samlAttributeMapping: null,
    ...overrides,
  };
}

async function consume(fixture, { cfg = makeCfg(), store = memoryStore(), inResponseTo = K.REQUEST_ID } = {}) {
  return samlService.consumeAssertion({
    cfg,
    samlResponse: b64(fixture),
    expectedInResponseTo: inResponseTo,
    store,
  });
}

/** Assert a refusal AND that it is the refusal we meant. */
async function expectRefusal(promise, code) {
  await expect(promise).rejects.toMatchObject({ errorCode: code });
}

beforeAll(() => {
  // Date is faked; setTimeout is not, so samlReplayStore's own deadline and
  // any awaited promise still behave normally.
  jest.useFakeTimers({
    doNotFake: [
      'setTimeout',
      'clearTimeout',
      'setInterval',
      'clearInterval',
      'setImmediate',
      'clearImmediate',
      'nextTick',
      'queueMicrotask',
      'performance',
      'hrtime',
    ],
  });
  jest.setSystemTime(new Date(K.NOW));
});

afterAll(() => {
  jest.useRealTimers();
});

// ---------------------------------------------------------------------------

describe('the known-good assertion', () => {
  test('validates and maps to the shape reconcileSsoUser expects', async () => {
    const profile = await consume('valid.xml');
    expect(profile.subject).toBe(K.NAME_ID);
    expect(profile.email).toBe('alice@example.com');
    expect(profile.name).toBe('Alice Example');
    expect(profile.emailVerified).toBe(true);
    expect(profile.assertionId).toBe(K.ASSERTION_ID);
    expect(profile.sessionIndex).toBe('_session0001');
    expect(profile.issuer).toBe(K.IDP_ENTITY_ID);
    expect(profile.groups).toEqual(['Engineering', 'Oncall']);
  });

  test('accepts a response where BOTH the response and the assertion are signed', async () => {
    const profile = await consume('both-signed.xml');
    expect(profile.subject).toBe(K.NAME_ID);
  });

  test('accepts it with wantAuthnResponseSigned on, when the response is in fact signed', async () => {
    const profile = await consume('both-signed.xml', {
      cfg: makeCfg({ samlWantAuthnResponseSigned: true }),
    });
    expect(profile.subject).toBe(K.NAME_ID);
  });
});

describe('signature', () => {
  test('refuses an assertion with no signature at all', async () => {
    await expectRefusal(consume('unsigned.xml'), 'saml_bad_signature');
  });

  test('refuses a signature made with a key we do not trust', async () => {
    await expectRefusal(consume('wrong-key.xml'), 'saml_bad_signature');
  });

  test('refuses a valid signature over content that was edited afterwards', async () => {
    await expectRefusal(consume('tampered-nameid.xml'), 'saml_bad_signature');
  });

  test('refuses an UNSIGNED assertion wrapped in a signed response', async () => {
    // wantAssertionsSigned is hardcoded true, so the envelope's signature
    // buys the attacker nothing.
    await expectRefusal(consume('response-signed-assertion-unsigned.xml'), 'saml_bad_signature');
  });

  test('refuses signature wrapping: a forged assertion beside a genuinely signed one', async () => {
    await expectRefusal(consume('signature-wrapping.xml'), 'saml_bad_signature');
  });

  test('refuses signature wrapping where the signed original is hidden in Extensions', async () => {
    await expectRefusal(consume('signature-wrapping-nested.xml'), 'saml_bad_signature');
  });

  test('refuses two assertions in one response', async () => {
    await expectRefusal(consume('two-assertions.xml'), 'saml_bad_signature');
  });

  test('is verified against the CONFIGURED certificate, never one carried in the document', async () => {
    // The attacker-signed fixture embeds the attacker's own certificate in its
    // KeyInfo. Configuring ONLY the attacker cert accepts it; configuring the
    // real IdP cert refuses it. If the embedded certificate were ever
    // consulted, both would pass.
    await expectRefusal(consume('wrong-key.xml', { cfg: makeCfg() }), 'saml_bad_signature');
    const profile = await consume('wrong-key.xml', { cfg: makeCfg({ idpCerts: [ATTACKER_CERT] }) });
    expect(profile.subject).toBe(K.NAME_ID);
  });

  test('accepts a signature from any one of several configured certificates (rotation)', async () => {
    const profile = await consume('valid.xml', {
      cfg: makeCfg({ idpCerts: [ATTACKER_CERT, IDP_CERT] }),
    });
    expect(profile.subject).toBe(K.NAME_ID);
  });

  test('refuses SHA-1 by default, and accepts it only when explicitly configured', async () => {
    await expectRefusal(consume('sha1-signed.xml'), 'saml_weak_signature');
    const profile = await consume('sha1-signed.xml', {
      cfg: makeCfg({ samlSignatureAlgorithm: 'sha1' }),
    });
    expect(profile.subject).toBe(K.NAME_ID);
  });

  test('the "SAML raw XML comment" bug: a comment in the NameID does not truncate the value', async () => {
    // CVE-2017-11428 and relatives. The signature covers
    // "alice@example.com<!---->.evil.example.org"; a verifier that read only
    // the first text node would hand us "alice@example.com" and let the
    // attacker impersonate Alice. The whole value must survive.
    const profile = await consume('comment-truncation.xml');
    expect(profile.subject).not.toBe('alice@example.com');
    expect(profile.subject).toBe('alice@example.com.evil.example.org');
  });
});

describe('audience, destination and issuer', () => {
  test('refuses an assertion minted for a different service provider', async () => {
    await expectRefusal(consume('wrong-audience.xml'), 'saml_audience_mismatch');
  });

  test('refuses an assertion with no AudienceRestriction at all', async () => {
    await expectRefusal(consume('no-conditions.xml'), 'saml_audience_mismatch');
  });

  test('refuses a Destination that names another ACS URL', async () => {
    await expectRefusal(consume('wrong-destination.xml'), 'saml_destination_mismatch');
  });

  test('refuses a signature-covered Recipient that names another ACS URL', async () => {
    // Destination is correct in this fixture; only the Recipient inside the
    // signed assertion is wrong, so this is the check that must catch it.
    await expectRefusal(consume('wrong-recipient.xml'), 'saml_destination_mismatch');
  });

  test('refuses an assertion issued by an entity other than the configured IdP', async () => {
    // Signed by the trusted key, so ONLY the Issuer check can refuse it. This
    // is the shared-certificate / multi-tenant IdP case.
    await expectRefusal(consume('wrong-issuer.xml'), 'saml_issuer_mismatch');
  });

  test('a cross-org replay fails on audience, destination AND trust — independently', async () => {
    const otherOrg = makeCfg({
      id: 'prov_bbb',
      orgId: 'org_2',
      acsUrl: K.OTHER_ACS_URL,
      spEntityId: 'https://shellius.test/api/auth/sso/saml/metadata/prov_bbb',
      idpCerts: [ATTACKER_CERT],
    });
    await expectRefusal(consume('valid.xml', { cfg: otherOrg }), 'saml_destination_mismatch');
    // Even with destination checking satisfied, the audience still names org
    // A's SP entity and the certificate still is not org B's.
    await expectRefusal(
      consume('valid.xml', { cfg: { ...otherOrg, acsUrl: K.ACS_URL } }),
      'saml_bad_signature'
    );
    await expectRefusal(
      consume('valid.xml', { cfg: { ...otherOrg, acsUrl: K.ACS_URL, idpCerts: [IDP_CERT] } }),
      'saml_audience_mismatch'
    );
  });

  test('URL comparison ignores a trailing slash but not a different path', async () => {
    expect(samlService.urlEquals('https://a.test/acs', 'https://a.test/acs/')).toBe(true);
    expect(samlService.urlEquals('https://A.TEST/acs', 'https://a.test/acs')).toBe(true);
    expect(samlService.urlEquals('https://a.test/acs', 'https://a.test/acs2')).toBe(false);
    expect(samlService.urlEquals('http://a.test/acs', 'https://a.test/acs')).toBe(false);
    expect(samlService.urlEquals('https://a.test/acs', 'https://a.test.evil/acs')).toBe(false);
  });
});

describe('time', () => {
  test('refuses an expired assertion', async () => {
    await expectRefusal(consume('expired.xml'), 'saml_expired');
  });

  test('refuses an assertion that is not yet valid', async () => {
    await expectRefusal(consume('not-yet-valid.xml'), 'saml_not_yet_valid');
  });

  test('accepts a 30s NotBefore skew at the default 60s tolerance', async () => {
    const profile = await consume('skew-30s.xml');
    expect(profile.subject).toBe(K.NAME_ID);
  });

  test('refuses that same 30s skew when tolerance is 0', async () => {
    await expectRefusal(consume('skew-30s.xml', { cfg: makeCfg({ clockSkewSec: 0 }) }), 'saml_not_yet_valid');
  });

  test('clock skew is clamped, so a hand-edited row cannot disable time checks', async () => {
    // -1 is node-saml's "skip every timestamp check" sentinel. It must not be
    // reachable through configuration.
    await expectRefusal(
      consume('expired.xml', { cfg: makeCfg({ clockSkewSec: -1, samlClockSkewSec: -1 }) }),
      'saml_expired'
    );
    await expectRefusal(
      consume('expired.xml', { cfg: makeCfg({ clockSkewSec: 99999, samlClockSkewSec: 99999 }) }),
      'saml_expired'
    );
  });
});

describe('replay', () => {
  test('the same assertion cannot be used twice — two independent reasons', async () => {
    const store = memoryStore();
    const first = await consume('valid.xml', { store });
    expect(first.subject).toBe(K.NAME_ID);

    // Layer one: the AuthnRequest id was consumed by the first use, so the
    // InResponseTo no longer matches anything outstanding.
    await expectRefusal(consume('valid.xml', { store }), 'saml_request_mismatch');

    // Layer two, which is the one that matters: even if the request binding
    // were somehow still valid — a concurrent second POST, a replica that had
    // not yet seen the delete, an IdP that reuses request ids — the
    // assertion-id claim refuses it on its own.
    store._requests.set(K.REQUEST_ID, new Date(K.ISSUE_INSTANT).toISOString());
    await expectRefusal(consume('valid.xml', { store }), 'saml_replay');
  });

  test('the claim is per provider, so one org consuming an id does not block another', async () => {
    const store = memoryStore();
    await consume('valid.xml', { store });
    expect(await store.claimAssertionId('prov_bbb', K.ASSERTION_ID)).toBe(true);
  });

  test('refuses a response bound to a different AuthnRequest', async () => {
    await expectRefusal(consume('other-inresponseto.xml'), 'saml_request_mismatch');
  });

  test('refuses an unsolicited response when IdP-initiated sign-in is off', async () => {
    await expectRefusal(
      consume('no-inresponseto.xml', { inResponseTo: null }),
      'saml_request_mismatch'
    );
  });

  test('accepts an unsolicited response when IdP-initiated sign-in is on, still once only', async () => {
    const store = memoryStore();
    const cfg = makeCfg({ samlAllowIdpInitiated: true });
    const profile = await consume('no-inresponseto.xml', { cfg, store, inResponseTo: null });
    expect(profile.subject).toBe(K.NAME_ID);
    // With no InResponseTo there is no request binding at all, so the
    // assertion-ID claim is the ONLY replay control left. It must hold.
    await expectRefusal(consume('no-inresponseto.xml', { cfg, store, inResponseTo: null }), 'saml_replay');
  });

  test('FAILS CLOSED when the replay store cannot answer', async () => {
    // Not "logs a warning and continues". Redis being down must refuse the
    // sign-in, because the alternative is silently unlimited replays that
    // look like ordinary logins.
    await expectRefusal(consume('valid.xml', { store: brokenStore() }), 'saml_replay_unavailable');
  });

  test('fails closed on the assertion claim specifically, not just the request lookup', async () => {
    const store = memoryStore();
    store.claimAssertionId = async () => {
      throw new SamlReplayStoreUnavailable('claimAssertionId');
    };
    await expectRefusal(consume('valid.xml', { store }), 'saml_replay_unavailable');
  });
});

describe('NameID', () => {
  test('refuses an assertion with no NameID', async () => {
    await expectRefusal(consume('no-nameid.xml'), 'saml_no_nameid');
  });

  test('refuses a transient NameID, which cannot identify a user across sign-ins', async () => {
    await expectRefusal(consume('transient-nameid.xml'), 'saml_transient_nameid');
  });

  test('refuses a NameID Format that does not match the configured one', async () => {
    await expectRefusal(
      consume('valid.xml', {
        cfg: makeCfg({ samlIdentifierFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent' }),
      }),
      'saml_nameid_format'
    );
  });

  test('a persistent NameID becomes the subject while email comes from attributes', async () => {
    const profile = await consume('persistent-nameid.xml');
    expect(profile.subject).toBe('f1e2d3c4-0000-0000-0000-abcdefabcdef');
    expect(profile.email).toBe('alice@example.com');
    expect(profile.name).toBe('Alice Example');
    expect(profile.externalId).toBe('aad-object-id-1');
  });
});

describe('attributes', () => {
  test('reads Shibboleth-style OID names via their FriendlyName', async () => {
    const profile = await consume('friendly-name-attributes.xml');
    expect(profile.email).toBe('alice@example.com');
    expect(profile.name).toBe('Alice Example');
  });

  test('a per-provider mapping takes precedence over the defaults', async () => {
    const profile = await consume('valid.xml', {
      cfg: makeCfg({ samlAttributeMapping: { name: 'groups' } }),
    });
    expect(profile.name).toBe('Engineering');
  });

  test('email is lowercased, matching what reconcileSsoUser compares against', async () => {
    const profile = await consume('valid.xml');
    expect(profile.email).toBe(profile.email.toLowerCase());
  });

  test('does not record a directory external id it cannot justify', async () => {
    const profile = await consume('valid.xml');
    expect(profile.externalId).toBeNull();
  });
});

describe('malformed and hostile input', () => {
  test('refuses a document carrying a DTD', async () => {
    await expectRefusal(consume('doctype.xml'), 'saml_invalid');
  });

  test('the DOCTYPE check is not fooled by the word appearing inside a comment', () => {
    expect(() => samlService.assertNoDoctype('<!-- <!DOCTYPE x> --><r/>')).not.toThrow();
    expect(() => samlService.assertNoDoctype('<!DOCTYPE x><r/>')).toThrow();
    expect(() => samlService.assertNoDoctype('<!doctype x><r/>')).toThrow();
  });

  test('refuses an empty or non-XML body', async () => {
    const cfg = makeCfg();
    await expectRefusal(
      samlService.consumeAssertion({ cfg, samlResponse: '', store: memoryStore() }),
      'saml_invalid'
    );
    await expectRefusal(
      samlService.consumeAssertion({
        cfg,
        samlResponse: Buffer.from('not xml at all', 'utf8').toString('base64'),
        store: memoryStore(),
      }),
      'saml_invalid'
    );
  });

  test('refuses a response larger than the cap before parsing it', async () => {
    await expect(
      samlService.consumeAssertion({
        cfg: makeCfg(),
        samlResponse: 'A'.repeat(samlService.MAX_SAML_RESPONSE_BYTES + 1),
        store: memoryStore(),
      })
    ).rejects.toMatchObject({ errorCode: 'saml_invalid', statusCode: 413 });
  });

  test('reports an IdP status failure as such, not as a signature problem', async () => {
    await expectRefusal(consume('status-failure.xml'), 'saml_idp_error');
  });

  test('never leaks the assertion, a certificate or a key in an error message', async () => {
    const errors = [];
    for (const f of ['unsigned.xml', 'wrong-key.xml', 'wrong-audience.xml', 'expired.xml', 'tampered-nameid.xml']) {
      await consume(f).catch((e) => errors.push(e.message));
    }
    expect(errors.length).toBe(5);
    for (const msg of errors) {
      expect(msg).not.toMatch(/BEGIN (CERTIFICATE|PRIVATE KEY)/);
      expect(msg).not.toMatch(/saml:Assertion|SignatureValue|alice@example\.com/);
    }
  });
});

describe('certificate handling', () => {
  test('accepts a pasted PEM, a bare base64 body, and several at once', () => {
    const bare = IDP_CERT.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
    expect(samlService.normalizeIdpCerts(IDP_CERT)).toHaveLength(1);
    expect(samlService.normalizeIdpCerts(bare)).toHaveLength(1);
    expect(samlService.normalizeIdpCerts(`${IDP_CERT}\n${ATTACKER_CERT}`)).toHaveLength(2);
    expect(samlService.normalizeIdpCerts([IDP_CERT, ATTACKER_CERT])).toHaveLength(2);
  });

  test('refuses junk that is not a certificate', () => {
    expect(() => samlService.normalizeIdpCerts('hello')).toThrow();
    expect(() => samlService.normalizeIdpCerts('')).toThrow();
    expect(() =>
      samlService.normalizeIdpCerts('-----BEGIN CERTIFICATE-----\nYWJj\n-----END CERTIFICATE-----')
    ).toThrow();
  });

  test('round-trips through encryption without ever storing plaintext', () => {
    const blob = samlService.encryptIdpCerts(IDP_CERT);
    expect(blob).not.toContain('BEGIN CERTIFICATE');
    expect(blob.startsWith('v2:')).toBe(true);
    const back = samlService.decryptIdpCerts({ samlIdpCertEncrypted: blob });
    expect(back).toHaveLength(1);
    expect(new crypto.X509Certificate(back[0]).subject).toContain('shellius-test-idp');
  });

  test('refuses a sign-in when no certificate is configured at all', () => {
    expect(() => samlService.buildSaml({ ...makeCfg(), idpCerts: [] }, { forLogin: true })).toThrow(/certificate/i);
  });

  test('refuses a sign-in once every configured certificate has expired', () => {
    // xml-crypto verifies against the KEY and never looks at the
    // certificate's validity dates, so an expired IdP certificate would keep
    // working forever if nothing checked. Jump past the fixtures' expiry to
    // prove something does.
    jest.setSystemTime(new Date('2200-01-01T00:00:00Z'));
    try {
      expect(() => samlService.buildSaml(makeCfg(), { forLogin: true })).toThrow(/expired/i);
    } finally {
      jest.setSystemTime(new Date(K.NOW));
    }
  });

  test('a rotation with one expired and one live certificate still works', () => {
    // The normal, healthy mid-rotation state. Refusing it would force every
    // org to take an outage at the exact moment of cutover.
    expect(() => samlService.buildSaml(makeCfg(), { forLogin: true })).not.toThrow();
  });

  test('generates an SP key pair whose certificate matches its key', () => {
    const sp = samlService.generateSpKeyPair();
    expect(sp.privateKeyPem).toContain('BEGIN PRIVATE KEY');
    expect(sp.certificatePem).toContain('BEGIN CERTIFICATE');
    const summary = samlService.certSummary(sp.certificatePem);
    expect(summary.expired).toBe(false);
    expect(summary.fingerprint).toBe(sp.fingerprint);
  });
});

describe('SP metadata', () => {
  test('publishes the ACS URL and EntityID and never the private key', () => {
    const sp = samlService.generateSpKeyPair();
    const xml = samlService.buildMetadata({
      ...makeCfg(),
      spPrivateKey: sp.privateKeyPem,
      spCertificate: sp.certificatePem,
    });
    expect(xml).toContain(K.ACS_URL);
    expect(xml).toContain(K.SP_ENTITY_ID);
    expect(xml).not.toContain('BEGIN PRIVATE KEY');
    expect(xml).not.toContain(sp.privateKeyPem.split('\n')[1]);
    // The IdP's certificate is not ours to publish either.
    expect(xml).not.toContain(IDP_CERT.split('\n')[1]);
  });
});
