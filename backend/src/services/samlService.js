/**
 * samlService.js — SAML 2.0 Web Browser SSO, as a second protocol adapter
 * behind the SAME reconciliation, linking, provisioning and audit paths the
 * OIDC callback uses. Nothing in here signs a JWT, creates a user or decides
 * who may sign in: it turns a signed assertion into the exact
 * `{ subject, email, emailVerified, name, picture, externalId }` shape that
 * `routes/sso.js` already hands to `ssoService.reconcileSsoUser()`.
 *
 * ## What the protocol gives us, and what it does not
 *
 * OIDC hands the backend a token it fetched itself, over TLS, from an
 * endpoint it discovered at a URL it configured. The channel authenticates
 * the issuer. SAML hands the backend a blob that arrived in a form POST from
 * the user's own browser. NOTHING about the channel is trustworthy. Every
 * property we need has to come out of the XML signature, and every property
 * that is not inside the signature is attacker-controlled.
 *
 * That inverts the usual reading order. In this file, treat any value read
 * before `validatePostResponseAsync()` returns as hostile input that may only
 * be used to REFUSE a sign-in, never to permit one or to decide who the user
 * is. `assertDestination()` is exactly that: it can fail a login, it can
 * never pass one.
 *
 * ## The validation chain, in order
 *
 *   1. size cap, then a DOCTYPE refusal (see `assertNoDoctype`)
 *   2. Destination, if the Response carries one, against OUR canonical ACS
 *      URL — never against the request's Host header
 *   3. signature algorithm floor (SHA-1 refused unless explicitly configured)
 *   4. node-saml: signature over the assertion, against the configured IdP
 *      certificate(s) ONLY; Conditions NotBefore / NotOnOrAfter; assertion
 *      age; AudienceRestriction; InResponseTo against the request id we
 *      stored when we sent the AuthnRequest
 *   5. Issuer equals the configured IdP EntityID
 *   6. SubjectConfirmationData Recipient — the signature-covered restatement
 *      of Destination — equals our ACS URL
 *   7. assertion lifetime is not absurd
 *   8. single-use claim on the assertion ID (atomic, fails CLOSED)
 *   9. NameID present, usable and of the expected Format
 *  10. attributes mapped
 *
 * ## Logging
 *
 * An assertion is a credential AND a pile of PII. Assertion XML, the response
 * XML, certificates and private keys are never logged, never returned by an
 * API and never put in an audit metadata field. Errors carry a stable code
 * and a short human message and nothing else.
 */

import crypto from 'crypto';
import sshpk from 'sshpk';
import { SAML, generateServiceProviderMetadata } from '@node-saml/node-saml';
import { DOMParser } from '@xmldom/xmldom';
import config from '../config/index.js';
import ApiError from '../utils/ApiError.js';
import logger from '../utils/logger.js';
import { encrypt, decrypt } from '../utils/crypto.js';
import { candidatesFor, ATTRIBUTE_KEYS } from '../config/samlAttributes.js';
import * as defaultReplayStore from './saml/samlReplayStore.js';
import { assertionTtlSeconds, SamlReplayStoreUnavailable } from './saml/samlReplayStore.js';

// ---------------------------------------------------------------------------
// Limits and constants
// ---------------------------------------------------------------------------

/** Biggest SAMLResponse (base64) we will even look at. Real ones with group
 *  attributes reach ~50KB; 1MB is far beyond any legitimate assertion and
 *  stops an XML bomb / memory-pressure attempt before the parser runs. */
export const MAX_SAML_RESPONSE_BYTES = 1024 * 1024;

/** How old an assertion may be, measured from its own IssueInstant. The
 *  browser POSTs it within seconds of issuance; anything older has been
 *  sitting somewhere. */
export const MAX_ASSERTION_AGE_MS = Number(process.env.SAML_MAX_ASSERTION_AGE_MS) || 10 * 60 * 1000;

/** Refuse an assertion whose own validity window is longer than this. An IdP
 *  offering a week-long assertion is offering a week-long bearer token, and
 *  our replay claim would have to be held for a week to cover it. */
export const MAX_ASSERTION_LIFETIME_SEC = 24 * 60 * 60;

export const MIN_CLOCK_SKEW_SEC = 0;
export const MAX_CLOCK_SKEW_SEC = 300;

const TRANSIENT_NAMEID_FORMAT = 'urn:oasis:names:tc:SAML:2.0:nameid-format:transient';
const UNSPECIFIED_NAMEID_FORMAT = 'urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified';
const EMAIL_NAMEID_FORMAT = 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress';

/** Signature / digest algorithm URIs, weakest first. */
const ALGO_STRENGTH = { sha1: 1, sha256: 2, sha384: 3, sha512: 4 };

const SIGNATURE_ALGO_URIS = {
  'http://www.w3.org/2000/09/xmldsig#rsa-sha1': 'sha1',
  'http://www.w3.org/2000/09/xmldsig#dsa-sha1': 'sha1',
  'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256': 'sha256',
  'http://www.w3.org/2001/04/xmldsig-more#rsa-sha384': 'sha384',
  'http://www.w3.org/2001/04/xmldsig-more#rsa-sha512': 'sha512',
  'http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha256': 'sha256',
  'http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha384': 'sha384',
  'http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha512': 'sha512',
};

const DIGEST_ALGO_URIS = {
  'http://www.w3.org/2000/09/xmldsig#sha1': 'sha1',
  'http://www.w3.org/2001/04/xmlenc#sha256': 'sha256',
  'http://www.w3.org/2001/04/xmldsig-more#sha384': 'sha384',
  'http://www.w3.org/2001/04/xmlenc#sha512': 'sha512',
};

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Same contract as `ssoService.ssoError`: a stable `errorCode` the ACS route
 * turns into `#error=<code>` on the login page. Duplicated rather than
 * imported to keep the import graph one-directional (ssoService does not know
 * SAML exists).
 */
export function samlError(code, message, statusCode = 403) {
  const err = new ApiError(statusCode, message);
  err.errorCode = code;
  return err;
}

// ---------------------------------------------------------------------------
// URLs — always derived from the configured public base URL, never from the
// inbound request. A Host header is attacker-controlled; an ACS URL computed
// from one would validate a Destination the attacker chose.
// ---------------------------------------------------------------------------

const base = () => config.publicBaseUrl.replace(/\/$/, '');

/** Where the IdP POSTs the assertion. Carries the provider id, which is
 *  globally unique and belongs to exactly one org — that is what keeps two
 *  orgs' SAML state from ever meeting. */
export function acsUrlFor(providerId) {
  return `${base()}/api/auth/sso/saml/acs/${providerId}`;
}

/** Public SP metadata document, and the default SP EntityID. */
export function metadataUrlFor(providerId) {
  return `${base()}/api/auth/sso/saml/metadata/${providerId}`;
}

/** Our EntityID — what the assertion's AudienceRestriction must name. */
export function spEntityIdFor(row) {
  return row.samlSpEntityId || metadataUrlFor(row.id);
}

// ---------------------------------------------------------------------------
// SP key pair
// ---------------------------------------------------------------------------

/**
 * Generate the SP's own RSA key pair and a long-lived self-signed
 * certificate, using sshpk (already a dependency for the SSH CA) so nothing
 * has to shell out to an `openssl` binary the runtime image does not ship.
 *
 * The key signs AuthnRequests and decrypts EncryptedAssertions. It is
 * returned in the clear exactly once, to the caller, which encrypts it before
 * it touches the database.
 *
 * RSA, not Ed25519: XML-DSig and XML-Enc interop in the SAML ecosystem is
 * RSA-and-ECDSA only, and every IdP worth naming rejects an Ed25519 SP
 * certificate outright.
 */
export function generateSpKeyPair({ commonName = 'shellius-sp', years = 5 } = {}) {
  const { privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const parsed = sshpk.parsePrivateKey(privateKey, 'pem');
  const identity = sshpk.identityFromDN(`CN=${commonName.replace(/[,=+<>#;\\"]/g, '')}`);
  const cert = sshpk.createSelfSignedCertificate(identity, parsed, {
    lifetime: years * 365 * 24 * 60 * 60,
    purposes: ['signature', 'keyEncryption'],
  });
  const certificatePem = cert.toBuffer('pem').toString('ascii');
  return {
    privateKeyPem: privateKey,
    certificatePem,
    fingerprint: certFingerprint(certificatePem),
  };
}

/** SHA-256 fingerprint of a PEM certificate, for display. Never the key. */
export function certFingerprint(pem) {
  try {
    const x = new crypto.X509Certificate(pem);
    return x.fingerprint256;
  } catch {
    return null;
  }
}

/** `{ notBefore, notAfter, subject, issuer, fingerprint }` — safe to return. */
export function certSummary(pem) {
  try {
    const x = new crypto.X509Certificate(pem);
    return {
      subject: x.subject,
      issuer: x.issuer,
      notBefore: new Date(x.validFrom).toISOString(),
      notAfter: new Date(x.validTo).toISOString(),
      fingerprint: x.fingerprint256,
      expired: new Date(x.validTo).getTime() < Date.now(),
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// IdP certificates
// ---------------------------------------------------------------------------

const PEM_BLOCK_RE = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

/**
 * Accept a certificate the way an admin will actually paste it: a PEM block,
 * several PEM blocks, or the bare base64 body that IdP admin consoles show
 * (Entra's "Certificate (Base64)" download, Okta's "X.509 Certificate" box).
 *
 * Returns normalised PEM strings. Throws on anything that is not a parseable
 * X.509 certificate — a misconfiguration that fails at save time is far
 * better than one that fails at 3am on every sign-in.
 *
 * Multiple certificates are a rotation aid, not a weakening: each is a
 * separate trust anchor the admin explicitly pasted, and node-saml accepts a
 * signature from any of them. That is what lets an org stage a new IdP
 * certificate alongside the old one and remove the old one afterwards,
 * instead of taking an outage at the exact moment of cutover.
 */
export function normalizeIdpCerts(input) {
  const raw = Array.isArray(input) ? input.join('\n') : String(input || '');
  if (!raw.trim()) throw new ApiError(400, 'An IdP signing certificate is required');

  let blocks = raw.match(PEM_BLOCK_RE);
  if (!blocks || blocks.length === 0) {
    const body = raw.replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/=]+$/.test(body) || body.length < 100) {
      throw new ApiError(400, 'IdP certificate is not valid PEM or base64 X.509 data');
    }
    blocks = [`-----BEGIN CERTIFICATE-----\n${body.replace(/(.{64})/g, '$1\n').trim()}\n-----END CERTIFICATE-----`];
  }

  const out = [];
  for (const block of blocks) {
    let x;
    try {
      x = new crypto.X509Certificate(block);
    } catch {
      throw new ApiError(400, 'IdP certificate could not be parsed as an X.509 certificate');
    }
    // An expired certificate is NOT rejected at save time. Rotation order in
    // the real world is "paste the new one, then the IdP starts using it",
    // and an org whose current certificate expired an hour ago still needs to
    // be able to paste a replacement. Expiry is surfaced in the DTO and
    // enforced at sign-in by assertCertsUsable().
    out.push(x.toString());
  }
  if (out.length > 5) throw new ApiError(400, 'At most 5 IdP certificates may be configured');
  return out;
}

/** Store shape: a JSON array of PEMs, encrypted as one blob. */
export function encryptIdpCerts(certs) {
  return encrypt(JSON.stringify(normalizeIdpCerts(certs)));
}

export function decryptIdpCerts(row) {
  if (!row?.samlIdpCertEncrypted) return [];
  const plain = decrypt(row.samlIdpCertEncrypted);
  try {
    const parsed = JSON.parse(plain);
    return Array.isArray(parsed) ? parsed : [String(parsed)];
  } catch {
    // A row written before the JSON-array shape, or by hand.
    return [plain];
  }
}

/**
 * Refuse to start a sign-in when every configured IdP certificate has
 * expired. node-saml would happily verify a signature against an expired
 * certificate — xml-crypto checks the key, not the certificate's validity
 * dates — so this is the only place that notices.
 *
 * Deliberately "every", not "any": during a rotation both an expired and a
 * current certificate are configured at once, and that is the normal, healthy
 * state we must not break.
 */
export function assertCertsUsable(certs) {
  if (!certs.length) {
    throw samlError('saml_not_configured', 'This provider has no IdP signing certificate configured');
  }
  const now = Date.now();
  const usable = certs.filter((pem) => {
    const s = certSummary(pem);
    return s && new Date(s.notAfter).getTime() > now;
  });
  if (usable.length === 0) {
    throw samlError(
      'saml_idp_cert_expired',
      "Every configured identity provider certificate has expired. An administrator must upload the provider's current certificate."
    );
  }
  return usable;
}

// ---------------------------------------------------------------------------
// Decrypted, ready-to-use config
// ---------------------------------------------------------------------------

/**
 * The SAML analogue of `ssoService.decryptProvider()`. Secrets live in memory
 * only for the duration of one request, exactly like the OIDC client secret
 * and the SSH CA private key.
 */
export function decryptSamlProvider(row) {
  return {
    ...row,
    idpCerts: decryptIdpCerts(row),
    spPrivateKey: row.samlSpPrivateKeyEncrypted ? decrypt(row.samlSpPrivateKeyEncrypted) : null,
    spCertificate: row.samlSpCertificate || null,
    spEntityId: spEntityIdFor(row),
    acsUrl: acsUrlFor(row.id),
    clockSkewSec: clampSkew(row.samlClockSkewSec),
    allowedDomains: row.allowedDomains || [],
    requireVerifiedEmail: row.requireVerifiedEmail !== false,
  };
}

function clampSkew(v) {
  const n = Number.isFinite(v) ? v : 60;
  return Math.min(MAX_CLOCK_SKEW_SEC, Math.max(MIN_CLOCK_SKEW_SEC, n));
}

// ---------------------------------------------------------------------------
// node-saml instance
// ---------------------------------------------------------------------------

/**
 * Build the node-saml `SAML` object for one provider.
 *
 * The non-obvious choices, each of which is a security decision:
 *
 *   wantAssertionsSigned: true — HARDCODED, not configurable. An unsigned
 *     assertion wrapped in a signed Response is the canonical SAML bypass:
 *     the envelope's signature says nothing about the assertion's contents,
 *     and libraries that accept it can be fed any identity the attacker
 *     likes. Requiring the assertion itself to be signed also means we never
 *     depend on the envelope at all.
 *
 *   wantAuthnResponseSigned: from config, default FALSE — because a large
 *     share of IdPs sign only the assertion, and defaulting this on would
 *     make the feature unusable with them. It is safe to default off ONLY
 *     because the line above is unconditional.
 *
 *   validateInResponseTo: 'always' unless the org has explicitly enabled
 *     IdP-initiated sign-in. This is the binding to a request we made; it is
 *     the OAuth `state` of SAML.
 *
 *   audience: our SP EntityID. Without it an assertion minted for a
 *     DIFFERENT service provider — by the same, entirely honest IdP — is a
 *     valid login here.
 *
 *   cacheProvider: Redis, per provider id, bounded and fail-closed. The
 *     in-memory default is per-process and lost on restart, which with more
 *     than one replica silently turns InResponseTo validation into a coin
 *     flip.
 *
 *   signatureAlgorithm: sha256 unless configured otherwise. node-saml's own
 *     default is sha1.
 *
 *   idpCert: the configured certificates, and only those. node-saml passes
 *     them to xml-crypto as the verification keys; the `KeyInfo` inside the
 *     document is never consulted as a trust anchor.
 */
export function buildSaml(cfg, { forLogin = false, fixedRequestId = null, store = defaultReplayStore } = {}) {
  const certs = forLogin ? assertCertsUsable(cfg.idpCerts) : cfg.idpCerts;
  if (!certs.length) {
    throw samlError('saml_not_configured', 'This provider has no IdP signing certificate configured');
  }
  if (forLogin && !cfg.samlIdpEntryPoint) {
    throw samlError('saml_not_configured', 'This provider has no IdP sign-in URL configured');
  }

  const signRequests = cfg.samlSignRequests !== false && !!cfg.spPrivateKey;

  return new SAML({
    // --- identities -------------------------------------------------------
    issuer: cfg.spEntityId,
    audience: cfg.spEntityId,
    callbackUrl: cfg.acsUrl,
    entryPoint: cfg.samlIdpEntryPoint || undefined,
    idpIssuer: cfg.samlIdpEntityId || undefined,

    // --- trust ------------------------------------------------------------
    idpCert: certs,
    wantAssertionsSigned: true,
    wantAuthnResponseSigned: cfg.samlWantAuthnResponseSigned === true,

    // --- time -------------------------------------------------------------
    acceptedClockSkewMs: clampSkew(cfg.clockSkewSec ?? cfg.samlClockSkewSec) * 1000,
    maxAssertionAgeMs: MAX_ASSERTION_AGE_MS,

    // --- replay -----------------------------------------------------------
    validateInResponseTo: cfg.samlAllowIdpInitiated === true ? 'ifPresent' : 'always',
    requestIdExpirationPeriodMs: 10 * 60 * 1000,
    cacheProvider: store.createCacheProvider(cfg.id),

    // --- our own key ------------------------------------------------------
    ...(signRequests ? { privateKey: cfg.spPrivateKey, publicCert: cfg.spCertificate } : {}),
    ...(cfg.spPrivateKey ? { decryptionPvk: cfg.spPrivateKey } : {}),
    signatureAlgorithm: cfg.samlSignatureAlgorithm || 'sha256',
    digestAlgorithm: cfg.samlDigestAlgorithm || 'http://www.w3.org/2001/04/xmlenc#sha256',

    // --- request shape ----------------------------------------------------
    identifierFormat: cfg.samlIdentifierFormat || null,
    forceAuthn: cfg.samlForceAuthn === true,
    disableRequestedAuthnContext: true,
    authnRequestBinding: 'HTTP-Redirect',
    // node-saml generates the AuthnRequest ID internally and does not hand it
    // back, but we need it: it is what `InResponseTo` is checked against and
    // what we store in the sign-in state. Pinning it here is the supported
    // seam. A SAML ID must not start with a digit (it is an xsd:ID), hence
    // the leading underscore.
    generateUniqueId: fixedRequestId
      ? () => fixedRequestId
      : () => `_${crypto.randomBytes(21).toString('hex')}`,
  });
}

/**
 * Start an SP-initiated sign-in.
 *
 * Returns the IdP redirect URL and the AuthnRequest id it carries. Building
 * the URL also writes that id into Redis through the cache provider — if
 * Redis is down, this THROWS and the sign-in never starts, which is the same
 * fail-closed posture the response side takes. Starting a login whose
 * InResponseTo could not be recorded would produce a response we then had to
 * either reject (confusing) or accept unchecked (a hole).
 */
export async function startLogin(cfg, relayState, { store = defaultReplayStore } = {}) {
  const requestId = `_${crypto.randomBytes(21).toString('hex')}`;
  const saml = buildSaml(cfg, { forLogin: true, fixedRequestId: requestId, store });
  const url = await saml.getAuthorizeUrlAsync(relayState, null, {});
  return { url, requestId };
}

/** The SP metadata an admin uploads to (or points) their IdP at. Public
 *  information only: EntityID, ACS URL, NameID format, our public cert. */
export function buildMetadata(cfg) {
  const hasKey = !!cfg.spPrivateKey && !!cfg.spCertificate;
  return generateServiceProviderMetadata({
    issuer: cfg.spEntityId,
    callbackUrl: cfg.acsUrl,
    identifierFormat: cfg.samlIdentifierFormat || null,
    wantAssertionsSigned: true,
    ...(hasKey
      ? {
          privateKey: cfg.spPrivateKey,
          publicCerts: cfg.spCertificate,
          decryptionPvk: cfg.spPrivateKey,
          decryptionCert: cfg.spCertificate,
          signatureAlgorithm: cfg.samlSignatureAlgorithm || 'sha256',
        }
      : {}),
    signMetadata: false,
  });
}

// ---------------------------------------------------------------------------
// Pre-validation checks on the raw document
// ---------------------------------------------------------------------------

/**
 * Refuse any document that carries a DTD.
 *
 * @xmldom/xmldom (0.8.x, what node-saml parses with) does not expand entity
 * references at all — a probe of `<!ENTITY xxe SYSTEM "file:///etc/passwd">`
 * leaves the literal text `&xxe;` in the document — so neither XXE nor
 * billion-laughs is reachable through it today. This check exists anyway
 * because "today" is doing a lot of work in that sentence: the protection is
 * a property of a transitive dependency's parser, not of anything we control,
 * and a future xmldom that grows DTD support would silently re-open both. A
 * DTD has no legitimate place in a SAML assertion, so refusing one costs
 * nothing and does not depend on the parser's behaviour.
 */
export function assertNoDoctype(xml) {
  // Strip comments first: `<!-- <!DOCTYPE -->` is not a DTD, and a scan that
  // does not know that is trivially made to reject valid documents.
  const withoutComments = xml.replace(/<!--[\s\S]*?-->/g, '');
  if (/<!DOCTYPE/i.test(withoutComments) || /<!ENTITY/i.test(withoutComments)) {
    throw samlError('saml_invalid', 'SAML response contains a document type declaration');
  }
}

function parseResponseDom(xml) {
  const errors = [];
  const doc = new DOMParser({
    errorHandler: {
      warning: () => {},
      error: (m) => errors.push(m),
      fatalError: (m) => errors.push(m),
    },
  }).parseFromString(xml, 'text/xml');
  if (!doc || !doc.documentElement) {
    throw samlError('saml_invalid', 'SAML response is not well-formed XML');
  }
  return doc;
}

/**
 * The Destination check.
 *
 * Read from the UNSIGNED envelope, so it can only ever cause a refusal — an
 * attacker who can edit it can make a good login fail, which gains them
 * nothing, and cannot make a bad one pass, because everything that decides
 * WHO is signing in comes out of the signed assertion.
 *
 * Its value is against a genuine class of mistake and attack: an assertion
 * minted for one Shellius ACS URL (another org's provider row, a staging
 * install, a different SP entirely) being replayed at this one. The
 * signature-covered version of the same statement is `Recipient` on the
 * SubjectConfirmationData, checked after validation in `assertRecipient()`;
 * this one catches the case earlier and with a clearer error.
 *
 * Absent Destination on a SIGNED response is itself a violation — the SAML
 * core spec makes it REQUIRED whenever the message is signed — so that is
 * refused too.
 */
export function assertDestination(doc, acsUrl, { responseSigned = false } = {}) {
  const root = doc.documentElement;
  const destination = root.getAttribute && root.getAttribute('Destination');
  if (!destination) {
    if (responseSigned) {
      throw samlError('saml_destination_mismatch', 'Signed SAML response has no Destination');
    }
    return;
  }
  if (!urlEquals(destination, acsUrl)) {
    throw samlError('saml_destination_mismatch', 'SAML response was issued for a different destination');
  }
}

/** Compare two absolute URLs for SAML endpoint equality. Scheme and host are
 *  case-insensitive; the path is not. A default port is equivalent to no
 *  port. Anything unparseable falls back to an exact string comparison. */
export function urlEquals(a, b) {
  if (a === b) return true;
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return (
      ua.protocol.toLowerCase() === ub.protocol.toLowerCase() &&
      ua.hostname.toLowerCase() === ub.hostname.toLowerCase() &&
      ua.port === ub.port &&
      ua.pathname.replace(/\/$/, '') === ub.pathname.replace(/\/$/, '')
    );
  } catch {
    return false;
  }
}

/**
 * Refuse signatures weaker than the provider's configured floor (sha256 by
 * default). SHA-1 collisions are practical, and XML-DSig's flexibility about
 * what a reference covers makes a chosen-prefix collision considerably more
 * useful to an attacker here than in most formats.
 *
 * An org stuck on an ancient AD FS can lower the floor to `sha1` explicitly.
 * There is no way to end up on SHA-1 by accident.
 *
 * Read from the unsigned document, which is sound for the same reason as
 * `assertDestination`: xml-crypto reads the algorithm from the very same
 * place when it verifies, so a document claiming a strong algorithm it did
 * not use fails verification rather than this check.
 */
export function assertSignatureAlgorithms(doc, minAlgo = 'sha256') {
  const floor = ALGO_STRENGTH[minAlgo] || ALGO_STRENGTH.sha256;
  const sigMethods = doc.getElementsByTagNameNS('http://www.w3.org/2000/09/xmldsig#', 'SignatureMethod');
  const digMethods = doc.getElementsByTagNameNS('http://www.w3.org/2000/09/xmldsig#', 'DigestMethod');

  for (let i = 0; i < sigMethods.length; i += 1) {
    const uri = sigMethods[i].getAttribute('Algorithm') || '';
    if (/hmac/i.test(uri)) {
      throw samlError('saml_weak_signature', 'SAML signature uses a symmetric (HMAC) algorithm');
    }
    const strength = ALGO_STRENGTH[SIGNATURE_ALGO_URIS[uri]];
    if (!strength) {
      throw samlError('saml_weak_signature', 'SAML signature uses an unrecognised algorithm');
    }
    if (strength < floor) {
      throw samlError('saml_weak_signature', 'SAML signature algorithm is weaker than this provider allows');
    }
  }
  for (let i = 0; i < digMethods.length; i += 1) {
    const uri = digMethods[i].getAttribute('Algorithm') || '';
    const strength = ALGO_STRENGTH[DIGEST_ALGO_URIS[uri]];
    if (!strength) {
      throw samlError('saml_weak_signature', 'SAML signature uses an unrecognised digest algorithm');
    }
    if (strength < floor) {
      throw samlError('saml_weak_signature', 'SAML digest algorithm is weaker than this provider allows');
    }
  }
}

// ---------------------------------------------------------------------------
// Post-validation checks on the SIGNED assertion
// ---------------------------------------------------------------------------

const firstText = (node) => {
  if (node == null) return null;
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return firstText(node[0]);
  if (typeof node === 'object' && '_' in node) return node._;
  return null;
};

/** Pull the facts we need out of node-saml's xml2js view of the SIGNED
 *  assertion bytes. Nothing here reads the response envelope. */
export function readAssertionFacts(profile) {
  const parsed = typeof profile.getAssertion === 'function' ? profile.getAssertion() : null;
  const assertion = parsed?.Assertion;
  if (!assertion) {
    throw samlError('saml_invalid', 'SAML assertion could not be read after validation');
  }
  const attrs = assertion.$ || {};
  const conditions = Array.isArray(assertion.Conditions) ? assertion.Conditions[0] : null;

  const confirmations = assertion.Subject?.[0]?.SubjectConfirmation || [];
  const recipients = [];
  const subjectInResponseTo = [];
  for (const c of confirmations) {
    const data = c?.SubjectConfirmationData?.[0]?.$;
    if (!data) continue;
    if (data.Recipient) recipients.push(data.Recipient);
    if (data.InResponseTo) subjectInResponseTo.push(data.InResponseTo);
  }

  return {
    id: attrs.ID || null,
    issueInstant: attrs.IssueInstant || null,
    version: attrs.Version || null,
    issuer: firstText(assertion.Issuer),
    notBefore: conditions?.$?.NotBefore || null,
    notOnOrAfter: conditions?.$?.NotOnOrAfter || null,
    recipients,
    subjectInResponseTo,
    attributeStatements: assertion.AttributeStatement || [],
  };
}

/**
 * The assertion must name the IdP we configured.
 *
 * A valid signature proves "somebody holding the private key for a
 * certificate this org pasted signed this". It does not say who. When the
 * same certificate is (mis)used by more than one issuer — shared ADFS farms,
 * a multi-tenant IdP that signs every tenant with one key — the Issuer is
 * what distinguishes them, and without this check a tenant of a shared IdP
 * could authenticate as a user of a different tenant.
 *
 * Skipped only when the org has not told us the EntityID, which is why the
 * API makes it required on create.
 */
export function assertIssuer(facts, expectedEntityId) {
  if (!expectedEntityId) return;
  if (!facts.issuer) {
    throw samlError('saml_issuer_mismatch', 'SAML assertion has no Issuer');
  }
  if (facts.issuer.trim() !== String(expectedEntityId).trim()) {
    throw samlError('saml_issuer_mismatch', 'SAML assertion came from an unexpected identity provider');
  }
}

/** Recipient is Destination restated INSIDE the signature. When the IdP
 *  supplies it (nearly all do, and the spec requires it for bearer
 *  confirmation) it is the authenticated statement of where this assertion
 *  was meant to be delivered. */
export function assertRecipient(facts, acsUrl) {
  if (!facts.recipients.length) return;
  if (!facts.recipients.some((r) => urlEquals(r, acsUrl))) {
    throw samlError('saml_destination_mismatch', 'SAML assertion was issued for a different service');
  }
}

/** An assertion whose own window is longer than a day is a long-lived bearer
 *  credential. Refuse it rather than hold a replay claim open that long. */
export function assertLifetime(facts) {
  if (!facts.notBefore || !facts.notOnOrAfter) return;
  const from = Date.parse(facts.notBefore);
  const to = Date.parse(facts.notOnOrAfter);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return;
  if ((to - from) / 1000 > MAX_ASSERTION_LIFETIME_SEC) {
    throw samlError('saml_invalid', 'SAML assertion validity window is unreasonably long');
  }
}

/**
 * The NameID becomes `UserIdentity.subject`, so it has to be STABLE. Two
 * formats are refused outright:
 *
 *   transient — unique per session by definition. Storing it as a subject
 *     would create a fresh identity row on every sign-in and make the
 *     (provider, subject) match — the strongest identity signal we have —
 *     useless, silently falling every login back to email matching.
 *
 *   an empty NameID — nothing to key on at all.
 *
 * When the provider declares an expected Format, a mismatch is refused too:
 * an IdP that suddenly switches format has changed every user's subject, and
 * proceeding would fork every account.
 */
export function assertNameId(profile, cfg) {
  const nameId = profile.nameID;
  if (!nameId || !String(nameId).trim()) {
    throw samlError('saml_no_nameid', 'SAML assertion does not contain a NameID');
  }
  const format = profile.nameIDFormat || null;
  if (format === TRANSIENT_NAMEID_FORMAT) {
    throw samlError(
      'saml_transient_nameid',
      'This provider sends a transient NameID, which cannot identify a user across sign-ins. Configure a persistent or email NameID format.'
    );
  }
  const expected = cfg.samlIdentifierFormat;
  if (expected && format && format !== expected) {
    throw samlError('saml_nameid_format', 'SAML NameID format does not match this provider configuration');
  }
  return { nameId: String(nameId).trim(), format };
}

// ---------------------------------------------------------------------------
// Attributes
// ---------------------------------------------------------------------------

/**
 * Index the signed assertion's attributes by BOTH `Name` and `FriendlyName`.
 *
 * node-saml's own `profile.attributes` keys on `Name` only, and a meaningful
 * number of IdPs (Shibboleth especially) send an OID as the Name and the
 * human label as the FriendlyName — mapping on the label alone would find
 * nothing.
 *
 * Reads only the SIGNED assertion.
 */
export function indexAttributes(facts) {
  const index = new Map();
  const put = (key, value) => {
    if (!key) return;
    if (!index.has(key)) index.set(key, value);
  };
  for (const statement of facts.attributeStatements) {
    for (const attribute of statement?.Attribute || []) {
      const name = attribute?.$?.Name;
      const friendly = attribute?.$?.FriendlyName;
      const values = (attribute?.AttributeValue || [])
        .map((v) => {
          if (v == null) return null;
          if (typeof v === 'string') return v;
          if (typeof v === 'object' && '_' in v) return v._;
          return null;
        })
        .filter((v) => typeof v === 'string' && v.trim() !== '');
      if (!values.length) continue;
      put(name, values);
      put(friendly, values);
    }
  }
  return index;
}

function pick(index, key, mapping, presetId) {
  for (const candidate of candidatesFor(key, mapping, presetId)) {
    const values = index.get(candidate);
    if (values && values.length) return values;
  }
  return [];
}

/**
 * Map the signed attribute set onto the same shape the OIDC callback
 * produces. Only `subject` is mandatory here; everything else is decided by
 * `reconcileSsoUser`, which already knows what to do with a missing email
 * (refuse) or a missing name (fall back to the address).
 */
export function mapProfile({ cfg, profile, facts }) {
  const index = indexAttributes(facts);
  const mapping = cfg.samlAttributeMapping || null;
  const presetId = cfg.presetId || null;

  const { nameId, format } = assertNameId(profile, cfg);

  const picked = {};
  for (const key of ATTRIBUTE_KEYS) picked[key] = pick(index, key, mapping, presetId);

  let email = picked.email[0] || null;
  // No email attribute, but the NameID IS an email address — use it. The
  // `unspecified` format is included because a large share of IdPs send an
  // address under it; a value that does not look like an address is not
  // promoted regardless of what the format claims.
  if (!email && (format === EMAIL_NAMEID_FORMAT || format === UNSPECIFIED_NAMEID_FORMAT || !format)) {
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(nameId)) email = nameId;
  }

  let name = picked.name[0] || null;
  if (!name) {
    const composed = [picked.firstName[0], picked.lastName[0]].filter(Boolean).join(' ').trim();
    name = composed || null;
  }

  return {
    subject: nameId,
    nameIdFormat: format,
    email: email ? String(email).toLowerCase().trim() : null,
    /**
     * SAML has no `email_verified`. The assertion is signed by THIS org's own
     * identity provider, which is the authority for its users' addresses —
     * that signature is a stronger statement about the address than a public
     * OIDC provider's `email_verified` boolean is. So a SAML sign-in counts
     * as verified.
     *
     * What this actually unlocks is narrow: `requireVerifiedEmail` only gates
     * linking an assertion to a pre-existing local account by email address.
     * The dangerous version of that — silently adopting an account that has a
     * password, or a privileged one — is refused by `linkConfirmationFor()`
     * for every protocol, SAML included, and still demands the account's own
     * password or an emailed approval.
     */
    emailVerified: true,
    name,
    picture: null,
    /** Directory id for directory sync. Only ever a value we can justify —
     *  see config/samlAttributes.js and services/directory/externalId.js. */
    externalId: picked.externalId[0] || null,
    /** Surfaced for audit metadata (a count only) and for future group
     *  mapping. Shellius does not map IdP groups to roles or Shellius groups
     *  for ANY protocol today — OIDC does not either — so these are not
     *  applied to the user. `defaultGroupId` is the supported mechanism. */
    groups: picked.groups,
  };
}

// ---------------------------------------------------------------------------
// The whole inbound path
// ---------------------------------------------------------------------------

/**
 * Validate one SAMLResponse and return the mapped profile.
 *
 * Every throw is an `ApiError` with an `errorCode`; the caller turns it into
 * `#error=<code>` and an `auth.sso_failed` audit entry. Nothing here logs the
 * assertion, the response, a certificate or a key.
 *
 * @param {object}  params
 * @param {object}  params.cfg              decrypted provider (decryptSamlProvider)
 * @param {string}  params.samlResponse     the raw base64 SAMLResponse field
 * @param {string?} params.expectedInResponseTo  request id from our RelayState
 * @returns {Promise<object>} mapped profile + `{ assertionId, sessionIndex }`
 */
export async function consumeAssertion({
  cfg,
  samlResponse,
  expectedInResponseTo = null,
  // Injected rather than mocked: this repo's jest ESM setup makes
  // `unstable_mockModule` unreliable (see services/__tests__/caService.test.js),
  // and the replay store is the one collaborator whose FAILURE behaviour has
  // to be tested, not just its success path.
  store = defaultReplayStore,
}) {
  if (typeof samlResponse !== 'string' || samlResponse.length === 0) {
    throw samlError('saml_invalid', 'Missing SAMLResponse', 400);
  }
  if (samlResponse.length > MAX_SAML_RESPONSE_BYTES) {
    throw samlError('saml_invalid', 'SAML response is too large', 413);
  }

  let xml;
  try {
    xml = Buffer.from(samlResponse, 'base64').toString('utf8');
  } catch {
    throw samlError('saml_invalid', 'SAML response is not valid base64', 400);
  }
  if (!xml.trim()) throw samlError('saml_invalid', 'SAML response is empty', 400);

  assertNoDoctype(xml);
  const doc = parseResponseDom(xml);
  assertDestination(doc, cfg.acsUrl, { responseSigned: cfg.samlWantAuthnResponseSigned === true });
  assertSignatureAlgorithms(doc, cfg.samlSignatureAlgorithm || 'sha256');

  const saml = buildSaml(cfg, { forLogin: true, store });

  let result;
  try {
    result = await saml.validatePostResponseAsync({ SAMLResponse: samlResponse });
  } catch (err) {
    if (err instanceof SamlReplayStoreUnavailable) {
      // Fail CLOSED. See services/saml/samlReplayStore.js for why.
      throw samlError(
        'saml_replay_unavailable',
        'Single sign-on is temporarily unavailable. Please try again shortly.',
        503
      );
    }
    // err.message can quote fragments of the document. Log the CLASS of
    // failure, never the message, and never the document.
    logger.warn('SAML assertion rejected', {
      providerId: cfg.id,
      orgId: cfg.orgId,
      reason: classifyValidationError(err),
    });
    throw samlError(classifyValidationError(err), 'The SAML assertion could not be validated');
  }

  const profile = result?.profile;
  if (!profile) {
    throw samlError('saml_invalid', 'SAML response contained no assertion');
  }

  const facts = readAssertionFacts(profile);
  assertIssuer(facts, cfg.samlIdpEntityId);
  assertRecipient(facts, cfg.acsUrl);
  assertLifetime(facts);

  // The RelayState we issued names the AuthnRequest we sent. node-saml has
  // already checked InResponseTo against Redis; this checks it against the
  // state THIS browser is carrying, so a response bound to somebody else's
  // in-flight request cannot be pasted into this one.
  if (expectedInResponseTo) {
    const seen = profile.inResponseTo || facts.subjectInResponseTo[0] || null;
    if (seen !== expectedInResponseTo) {
      throw samlError('saml_request_mismatch', 'SAML response does not match the sign-in that started it');
    }
  }

  if (!facts.id) {
    throw samlError('saml_invalid', 'SAML assertion has no ID, so it cannot be tracked against replay');
  }

  // ---- single use -------------------------------------------------------
  // Last, because everything above is cheaper; and unconditional, because an
  // IdP-initiated assertion has no InResponseTo and this is then the ONLY
  // thing that stops it being replayed until it expires.
  let claimed;
  try {
    claimed = await store.claimAssertionId(
      cfg.id,
      facts.id,
      assertionTtlSeconds({ notOnOrAfter: facts.notOnOrAfter, clockSkewSec: cfg.clockSkewSec })
    );
  } catch (err) {
    if (err instanceof SamlReplayStoreUnavailable) {
      throw samlError(
        'saml_replay_unavailable',
        'Single sign-on is temporarily unavailable. Please try again shortly.',
        503
      );
    }
    throw err;
  }
  if (!claimed) {
    logger.warn('SAML assertion replay refused', { providerId: cfg.id, orgId: cfg.orgId });
    throw samlError('saml_replay', 'This SAML assertion has already been used');
  }

  const mapped = mapProfile({ cfg, profile, facts });
  return {
    ...mapped,
    assertionId: facts.id,
    sessionIndex: profile.sessionIndex || null,
    issuer: facts.issuer,
  };
}

/**
 * Turn a node-saml error into one of our stable codes WITHOUT propagating its
 * message, which can embed document fragments (audience values, timestamps,
 * status messages) into a URL fragment and an audit row.
 */
export function classifyValidationError(err) {
  const msg = String(err?.message || '');
  if (/InResponseTo/i.test(msg)) return 'saml_request_mismatch';
  if (/audience/i.test(msg)) return 'saml_audience_mismatch';
  if (/not yet valid/i.test(msg)) return 'saml_not_yet_valid';
  if (/expired|too old|clocks skewed/i.test(msg)) return 'saml_expired';
  // node-saml's wording when every SubjectConfirmationData failed its
  // timestamp check, which is the only thing that can invalidate one.
  if (/subject confirmation/i.test(msg)) return 'saml_expired';
  if (/signature/i.test(msg)) return 'saml_bad_signature';
  if (/decryption|decrypt/i.test(msg)) return 'saml_decrypt_failed';
  if (/Missing SAML assertion|no assertion/i.test(msg)) return 'saml_no_assertion';
  if (/SAML provider returned/i.test(msg)) return 'saml_idp_error';
  return 'saml_invalid';
}

export default {
  acsUrlFor,
  metadataUrlFor,
  spEntityIdFor,
  generateSpKeyPair,
  certFingerprint,
  certSummary,
  normalizeIdpCerts,
  encryptIdpCerts,
  decryptIdpCerts,
  decryptSamlProvider,
  buildSaml,
  startLogin,
  buildMetadata,
  consumeAssertion,
  samlError,
};
