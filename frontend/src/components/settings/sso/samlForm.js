/**
 * samlForm.js — the pure half of the SAML provider form.
 *
 * Everything here mirrors a rule that the backend already enforces, so the
 * admin finds out about a bad paste while they are still looking at the
 * field rather than after a round trip (or worse, at 3am on a sign-in). The
 * authorities, all of which were read to write this file, are:
 *
 *   backend/src/routes/sso.js            `samlFields` — the accepted keys and
 *                                        their bounds (this file must not
 *                                        send anything outside that set)
 *   backend/src/services/samlService.js  normalizeIdpCerts, clampSkew,
 *                                        assertSignatureAlgorithms,
 *                                        assertNameId, buildSaml
 *   backend/src/services/ssoConfigService.js  samlWriteFields — "a blank
 *                                        certificate on update keeps the
 *                                        stored one", and the DTO that never
 *                                        returns a secret
 *   backend/src/config/samlAttributes.js ATTRIBUTE_KEYS — the fixed key set
 *
 * None of this is a substitute for the backend checks: the client cannot
 * parse X.509, so "looks like a certificate" is the strongest claim it makes.
 * The server still rejects a well-shaped but unparseable certificate.
 */

/** Preset ids the backend treats as SAML (routes/sso.js SAML_PRESET_IDS). */
export const SAML_PRESET_IDS = ['saml', 'saml-entra', 'saml-okta', 'saml-adfs'];

export const isSamlPreset = (presetId) => SAML_PRESET_IDS.includes(presetId);

/**
 * Is this form editing a SAML provider?
 *
 * The saved DTO's `provider` field wins, because a provider can be created
 * through the API with a preset id this build of the UI has never heard of,
 * and a SAML row must never be rendered with the OIDC fields (the backend
 * refuses a protocol change outright — ssoConfigService.updateProvider).
 */
export function isSamlProvider(preset, existingProvider) {
  if (existingProvider?.provider) return existingProvider.provider === 'saml';
  if (preset?.protocol === 'saml') return true;
  return isSamlPreset(preset?.id);
}

// ---------------------------------------------------------------------------
// Bounds, mirrored from the backend
// ---------------------------------------------------------------------------

/** samlService.normalizeIdpCerts: "At most 5 IdP certificates". */
export const MAX_IDP_CERTS = 5;
/** routes/sso.js: samlIdpCertificate Joi.string().max(100000). */
export const MAX_CERT_CHARS = 100000;
/** samlService MIN/MAX_CLOCK_SKEW_SEC, also the Joi bounds. */
export const MIN_CLOCK_SKEW_SEC = 0;
export const MAX_CLOCK_SKEW_SEC = 300;
export const DEFAULT_CLOCK_SKEW_SEC = 60;
export const MAX_ENTRY_POINT_CHARS = 2000;
export const MAX_ENTITY_ID_CHARS = 1024;
export const MAX_IDENTIFIER_FORMAT_CHARS = 200;
export const MAX_ATTRIBUTE_NAME_CHARS = 300;

/** Joi `samlSignatureAlgorithm` accepts exactly these three. */
export const SIGNATURE_ALGORITHMS = [
  { value: 'sha256', label: 'SHA-256 (recommended)' },
  { value: 'sha512', label: 'SHA-512' },
  { value: 'sha1', label: 'SHA-1 (legacy AD FS only)' },
];

const TRANSIENT_NAMEID_FORMAT = 'urn:oasis:names:tc:SAML:2.0:nameid-format:transient';

/**
 * NameID formats worth offering. `transient` is deliberately NOT here:
 * samlService.assertNameId refuses a transient NameID at sign-in, so offering
 * it would be offering a provider that cannot work. A row that already holds
 * it (set through the API) is still shown — see `nameIdFormatOptions`.
 */
export const NAMEID_FORMATS = [
  { value: '', label: 'Any (do not request a specific format)' },
  { value: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress', label: 'Email address' },
  { value: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent', label: 'Persistent' },
  { value: 'urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified', label: 'Unspecified' },
  { value: 'urn:oasis:names:tc:SAML:2.0:nameid-format:windowsDomainQualifiedName', label: 'Windows domain qualified name' },
];

/**
 * The option list to render, including a stored value this build does not
 * know about (a provider created through the API, or written by a newer
 * release). Never silently rewrite what is stored.
 */
export function nameIdFormatOptions(storedValue) {
  const value = (storedValue || '').trim();
  if (!value || NAMEID_FORMATS.some((o) => o.value === value)) return NAMEID_FORMATS;
  const label = value === TRANSIENT_NAMEID_FORMAT ? 'Transient (stored — sign-in will be refused)' : `${value} (stored)`;
  return [...NAMEID_FORMATS, { value, label }];
}

export function signatureAlgorithmOptions(storedValue) {
  const value = (storedValue || '').trim();
  if (!value || SIGNATURE_ALGORITHMS.some((o) => o.value === value)) return SIGNATURE_ALGORITHMS;
  return [...SIGNATURE_ALGORITHMS, { value, label: `${value} (stored)` }];
}

/** backend/src/config/samlAttributes.js ATTRIBUTE_KEYS, in display order. */
export const ATTRIBUTE_MAPPING_FIELDS = [
  { key: 'email', label: 'Email', placeholder: 'email' },
  { key: 'name', label: 'Display name', placeholder: 'displayName' },
  { key: 'firstName', label: 'First name', placeholder: 'firstName' },
  { key: 'lastName', label: 'Last name', placeholder: 'lastName' },
  { key: 'groups', label: 'Groups', placeholder: 'groups' },
  { key: 'externalId', label: 'Directory ID', placeholder: 'objectidentifier' },
];

export const ATTRIBUTE_MAPPING_KEYS = ATTRIBUTE_MAPPING_FIELDS.map((f) => f.key);

// ---------------------------------------------------------------------------
// Certificate input
// ---------------------------------------------------------------------------

const PEM_BLOCK_RE = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;
const PRIVATE_KEY_RE = /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/;

/**
 * Normalise a pasted certificate the way the backend will read it: CRLF and
 * lone CR become LF (an admin pasting out of a Windows IdP console, or out of
 * Notepad, gets \r\n), and surrounding whitespace goes. Nothing INSIDE the
 * text is rewritten — samlService.normalizeIdpCerts does the real work and a
 * clever client-side "fix" would only hide a genuine paste error.
 */
export function normalizeCertificateText(input) {
  if (typeof input !== 'string') return '';
  return input.replace(/\r\n?/g, '\n').trim();
}

/**
 * Describe a pasted certificate field without parsing X.509 (which a browser
 * cannot do). Recognises the three shapes samlService.normalizeIdpCerts
 * accepts — one PEM block, several PEM blocks, or the bare base64 body an IdP
 * console shows — and rejects the shapes it is known to reject.
 *
 * @returns {{ empty: boolean, count: number, text: string, error: string|null }}
 */
export function inspectCertificateInput(input) {
  const text = normalizeCertificateText(input);
  if (!text) return { empty: true, count: 0, text: '', error: null };

  if (text.length > MAX_CERT_CHARS) {
    return { empty: false, count: 0, text, error: `Certificate is too long (${text.length} characters; the limit is ${MAX_CERT_CHARS}).` };
  }
  if (PRIVATE_KEY_RE.test(text)) {
    return { empty: false, count: 0, text, error: 'That is a private key. Paste the identity provider\'s public signing certificate instead.' };
  }

  const blocks = text.match(PEM_BLOCK_RE);
  if (blocks && blocks.length) {
    if (blocks.length > MAX_IDP_CERTS) {
      return { empty: false, count: blocks.length, text, error: `At most ${MAX_IDP_CERTS} certificates can be configured (found ${blocks.length}).` };
    }
    return { empty: false, count: blocks.length, text, error: null };
  }

  // No complete block. A stray BEGIN/END means a truncated or non-certificate
  // PEM — the backend's bare-base64 fallback would choke on the dashes.
  if (/-----BEGIN/.test(text) || /-----END/.test(text)) {
    return { empty: false, count: 0, text, error: 'Incomplete PEM block — a certificate needs both the BEGIN CERTIFICATE and END CERTIFICATE lines.' };
  }

  const body = text.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/=]+$/.test(body)) {
    return { empty: false, count: 0, text, error: 'Not valid PEM or base64 certificate data.' };
  }
  if (body.length < 100) {
    return { empty: false, count: 0, text, error: 'Too short to be an X.509 certificate.' };
  }
  return { empty: false, count: 1, text, error: null };
}

// ---------------------------------------------------------------------------
// Clock skew
// ---------------------------------------------------------------------------

/**
 * @returns {{ value: number|null, error: string|null }} — `value: null` with
 * no error means "leave it out of the request" (the backend defaults to 60).
 */
export function parseClockSkew(input) {
  const raw = input === null || input === undefined ? '' : String(input).trim();
  if (!raw) return { value: null, error: null };
  if (!/^\d+$/.test(raw)) {
    return { value: null, error: 'Clock skew must be a whole number of seconds.' };
  }
  const n = Number(raw);
  if (n < MIN_CLOCK_SKEW_SEC || n > MAX_CLOCK_SKEW_SEC) {
    return { value: null, error: `Clock skew must be between ${MIN_CLOCK_SKEW_SEC} and ${MAX_CLOCK_SKEW_SEC} seconds.` };
  }
  return { value: n, error: null };
}

// ---------------------------------------------------------------------------
// URLs and identifiers
// ---------------------------------------------------------------------------

export function validateEntryPoint(input) {
  const value = (input || '').trim();
  if (!value) return 'An IdP sign-in URL is required.';
  if (value.length > MAX_ENTRY_POINT_CHARS) return `IdP sign-in URL is too long (limit ${MAX_ENTRY_POINT_CHARS} characters).`;
  let url;
  try {
    url = new URL(value);
  } catch {
    return 'IdP sign-in URL must be an absolute URL, e.g. https://idp.example.com/sso.';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return 'IdP sign-in URL must use https (or http for a local test IdP).';
  }
  return null;
}

/**
 * The IdP EntityID is an identifier, not necessarily a URL — plenty of IdPs
 * issue a URN, and AD FS issues `http://host/adfs/services/trust`. So this
 * only checks presence and length, exactly like the backend.
 */
export function validateEntityId(input, { required = true, label = 'IdP EntityID' } = {}) {
  const value = (input || '').trim();
  if (!value) return required ? `${label} is required.` : null;
  if (value.length > MAX_ENTITY_ID_CHARS) return `${label} is too long (limit ${MAX_ENTITY_ID_CHARS} characters).`;
  return null;
}

export function validateIdentifierFormat(input) {
  const value = (input || '').trim();
  if (!value) return null;
  if (value.length > MAX_IDENTIFIER_FORMAT_CHARS) return `NameID format is too long (limit ${MAX_IDENTIFIER_FORMAT_CHARS} characters).`;
  return null;
}

// ---------------------------------------------------------------------------
// Attribute mapping
// ---------------------------------------------------------------------------

/**
 * Keep only the keys `backend/src/config/samlAttributes.js` defines, trimmed,
 * dropping blanks. An all-blank map is `null`, which is what clears a stored
 * mapping and puts the provider back on the built-in candidate lists.
 *
 * Unknown keys are dropped rather than reported: they can only arrive from a
 * row written by a newer release or by hand, and the backend's Joi schema
 * would strip them anyway (`stripUnknown: true`).
 *
 * @returns {{ value: object|null, error: string|null, dropped: string[] }}
 */
export function cleanAttributeMapping(mapping) {
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) {
    return { value: null, error: null, dropped: [] };
  }
  const value = {};
  const dropped = [];
  for (const [key, raw] of Object.entries(mapping)) {
    if (!ATTRIBUTE_MAPPING_KEYS.includes(key)) {
      dropped.push(key);
      continue;
    }
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (trimmed.length > MAX_ATTRIBUTE_NAME_CHARS) {
      return { value: null, error: `Attribute name for "${key}" is too long (limit ${MAX_ATTRIBUTE_NAME_CHARS} characters).`, dropped };
    }
    value[key] = trimmed;
  }
  return { value: Object.keys(value).length ? value : null, error: null, dropped };
}

// ---------------------------------------------------------------------------
// Form state <-> DTO
// ---------------------------------------------------------------------------

/**
 * Seed the form from a saved provider DTO.
 *
 * The IdP certificate is ALWAYS blank: the DTO never returns it (only
 * `hasIdpCertificate` and per-certificate summaries), so there is nothing to
 * prefill and a blank field means "keep what is stored" on save — the same
 * contract the OIDC client secret already has.
 *
 * The SP EntityID override is blank whenever the stored value equals the
 * derived default. `spEntityIdFor()` returns `samlSpEntityId || metadataUrl`,
 * so the DTO cannot distinguish "unset" from "set to the default" — treating
 * the default as unset keeps a save from pinning a value the admin never
 * chose.
 */
export function samlStateFromProvider(provider) {
  const p = provider || {};
  const mapping = p.samlAttributeMapping && typeof p.samlAttributeMapping === 'object' && !Array.isArray(p.samlAttributeMapping)
    ? p.samlAttributeMapping
    : {};
  const attributeMapping = {};
  for (const key of ATTRIBUTE_MAPPING_KEYS) {
    attributeMapping[key] = typeof mapping[key] === 'string' ? mapping[key] : '';
  }
  const spEntityId = p.samlSpEntityId || '';
  return {
    idpEntryPoint: p.samlIdpEntryPoint || '',
    idpEntityId: p.samlIdpEntityId || '',
    idpCertificate: '',
    spEntityIdOverride: spEntityId && spEntityId !== p.samlMetadataUrl ? spEntityId : '',
    signatureAlgorithm: p.samlSignatureAlgorithm || 'sha256',
    wantAuthnResponseSigned: p.samlWantAuthnResponseSigned === true,
    allowIdpInitiated: p.samlAllowIdpInitiated === true,
    clockSkewSec:
      p.samlClockSkewSec === null || p.samlClockSkewSec === undefined
        ? String(DEFAULT_CLOCK_SKEW_SEC)
        : String(p.samlClockSkewSec),
    identifierFormat: p.samlIdentifierFormat || '',
    forceAuthn: p.samlForceAuthn === true,
    signRequests: p.samlSignRequests !== false,
    attributeMapping,
  };
}

/**
 * Validate the SAML half of the form.
 *
 * @param {object} state
 * @param {{ hasStoredCertificate?: boolean }} opts
 * @returns {{ valid: boolean, errors: Record<string,string> }}
 */
export function validateSamlForm(state, { hasStoredCertificate = false } = {}) {
  const s = state || {};
  const errors = {};

  const entryPointError = validateEntryPoint(s.idpEntryPoint);
  if (entryPointError) errors.idpEntryPoint = entryPointError;

  const entityIdError = validateEntityId(s.idpEntityId);
  if (entityIdError) errors.idpEntityId = entityIdError;

  const cert = inspectCertificateInput(s.idpCertificate);
  if (cert.error) errors.idpCertificate = cert.error;
  else if (cert.empty && !hasStoredCertificate) errors.idpCertificate = 'An IdP signing certificate is required.';

  const spEntityIdError = validateEntityId(s.spEntityIdOverride, { required: false, label: 'Service Provider EntityID' });
  if (spEntityIdError) errors.spEntityIdOverride = spEntityIdError;

  const skew = parseClockSkew(s.clockSkewSec);
  if (skew.error) errors.clockSkewSec = skew.error;

  const formatError = validateIdentifierFormat(s.identifierFormat);
  if (formatError) errors.identifierFormat = formatError;

  const mapping = cleanAttributeMapping(s.attributeMapping);
  if (mapping.error) errors.attributeMapping = mapping.error;

  return { valid: Object.keys(errors).length === 0, errors };
}

/**
 * The SAML-only keys of the request body. Merged with the shared provider
 * fields (name, defaultRole, allowedDomains, ...) by ProviderForm.
 *
 * Two rules do the real work here:
 *
 *   - a blank certificate is OMITTED, never sent as '', so an admin editing
 *     "allowed domains" cannot wipe a certificate they are not allowed to
 *     read back (ssoConfigService.samlWriteFields keeps the stored value when
 *     the field is absent or falsy);
 *   - on create, optional blanks are omitted so the backend's own defaults
 *     apply; on edit they are sent as '' / null, which is how the backend
 *     spells "clear this".
 *
 * Nothing outside `samlFields` in routes/sso.js is ever sent, so a SAML body
 * never carries a clientId, clientSecret, issuerUrl or scopes (Joi forbids
 * clientId/clientSecret on a SAML create outright).
 */
export function buildSamlFields(state, { isEdit = false } = {}) {
  const s = state || {};
  const body = {
    samlIdpEntryPoint: (s.idpEntryPoint || '').trim(),
    samlIdpEntityId: (s.idpEntityId || '').trim(),
    samlSignatureAlgorithm: s.signatureAlgorithm || 'sha256',
    samlWantAuthnResponseSigned: !!s.wantAuthnResponseSigned,
    samlAllowIdpInitiated: !!s.allowIdpInitiated,
    samlForceAuthn: !!s.forceAuthn,
    samlSignRequests: !!s.signRequests,
  };

  const cert = inspectCertificateInput(s.idpCertificate);
  if (!cert.empty && !cert.error) body.samlIdpCertificate = cert.text;

  const skew = parseClockSkew(s.clockSkewSec);
  if (skew.value !== null) body.samlClockSkewSec = skew.value;

  const spEntityId = (s.spEntityIdOverride || '').trim();
  if (spEntityId) body.samlSpEntityId = spEntityId;
  else if (isEdit) body.samlSpEntityId = '';

  const identifierFormat = (s.identifierFormat || '').trim();
  if (identifierFormat) body.samlIdentifierFormat = identifierFormat;
  else if (isEdit) body.samlIdentifierFormat = '';

  const mapping = cleanAttributeMapping(s.attributeMapping);
  if (mapping.value) body.samlAttributeMapping = mapping.value;
  else if (isEdit) body.samlAttributeMapping = null;

  return body;
}

// ---------------------------------------------------------------------------
// Derived display
// ---------------------------------------------------------------------------

const DAY_MS = 86400000;

/**
 * Turn one `certSummary()` entry from the DTO into a badge. Expiry matters:
 * `assertCertsUsable()` refuses to start a sign-in once EVERY configured
 * certificate has expired, and an expired one alongside a live one is the
 * normal, healthy middle of a rotation.
 */
export function certificateStatus(summary, now = Date.now()) {
  if (!summary) return { tone: 'neutral', label: 'Unreadable', daysLeft: null };
  const notAfter = Date.parse(summary.notAfter);
  if (!Number.isFinite(notAfter)) return { tone: 'neutral', label: 'Unknown expiry', daysLeft: null };
  const daysLeft = Math.floor((notAfter - now) / DAY_MS);
  if (summary.expired || daysLeft < 0) return { tone: 'danger', label: 'Expired', daysLeft };
  if (daysLeft <= 30) return { tone: 'warning', label: `Expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`, daysLeft };
  return { tone: 'success', label: `Valid for ${daysLeft} days`, daysLeft };
}

/** Short SHA-256 fingerprint for display next to a full copyable value. */
export function shortFingerprint(fingerprint) {
  if (typeof fingerprint !== 'string' || !fingerprint) return '';
  const parts = fingerprint.split(':');
  if (parts.length < 8) return fingerprint;
  return `${parts.slice(0, 4).join(':')}…${parts.slice(-4).join(':')}`;
}

/**
 * The advisories shown under the advanced section. Deliberately the same
 * judgements `ssoConfigService.testSamlProvider()` makes, so the form and the
 * "Test configuration" result never contradict each other.
 */
export function samlAdvisories(state, provider) {
  const s = state || {};
  const out = [];

  if (s.allowIdpInitiated) {
    out.push({
      level: 'warning',
      message:
        'IdP-initiated sign-in is on. Those responses carry no InResponseTo, so nothing ties them to a sign-in this server started — replay protection falls back to assertion-ID tracking alone.',
    });
  }
  if (s.signatureAlgorithm === 'sha1') {
    out.push({
      level: 'warning',
      message: 'SHA-1 signatures will be accepted. SHA-1 collisions are practical; only lower the floor for an AD FS that cannot be upgraded.',
    });
  }
  if ((s.identifierFormat || '').trim() === TRANSIENT_NAMEID_FORMAT) {
    out.push({
      level: 'error',
      message: 'A transient NameID changes on every sign-in and is refused at the assertion consumer. Choose a persistent or email format.',
    });
  }
  if (!s.signRequests) {
    out.push({
      level: 'info',
      message: 'AuthnRequests will be sent unsigned. Some IdPs require a signed request; leave this on unless yours rejects them.',
    });
  }
  if (provider && provider.provider === 'saml' && provider.hasSpKey === false) {
    out.push({
      level: 'warning',
      message: 'This provider has no Service Provider key pair, so requests cannot be signed and encrypted assertions cannot be decrypted. Rotate the SP key to generate one.',
    });
  }
  if (provider && provider.hasIdpCertificate && Array.isArray(provider.idpCertificates) && provider.idpCertificates.length === 0) {
    out.push({
      level: 'error',
      message: 'A certificate is stored but could not be decrypted with the current server encryption key. Paste the provider\'s certificate again.',
    });
  }
  return out;
}
