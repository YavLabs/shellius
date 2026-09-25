/**
 * samlAttributes.js — how a SAML assertion's AttributeStatement becomes the
 * same `{ email, name, groups, externalId }` shape the OIDC callback produces
 * from its claims.
 *
 * SAML has no equivalent of OIDC's standard claim names. Every IdP invents
 * its own attribute `Name`, and the same IdP emits different ones depending
 * on how the app was set up. So the mapping is configurable per provider
 * (`SsoConfig.samlAttributeMapping`) and falls back to this list of
 * candidates, tried in order, first non-empty wins.
 *
 * The candidates below are the ones actually emitted by:
 *   - Microsoft Entra ID / AD FS — the http://schemas.xmlsoap.org/... and
 *     http://schemas.microsoft.com/... claim URIs
 *   - Okta            — the short names you type into the SAML app's
 *                       attribute statements ("email", "firstName", ...)
 *   - Shibboleth / SimpleSAMLphp / most academic IdPs — the urn:oid: forms
 *   - Google Workspace — short names, same shape as Okta
 *
 * NOTE ON ORDER: `email` deliberately does NOT fall back to NameID here.
 * Whether the NameID may be used as the email address depends on its Format
 * (emailAddress vs persistent vs transient) and that decision lives in
 * samlService, not in a candidate list.
 */

export const DEFAULT_ATTRIBUTE_CANDIDATES = {
  email: [
    'email',
    'mail',
    'emailAddress',
    'Email',
    'EmailAddress',
    'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
    'http://schemas.xmlsoap.org/claims/EmailAddress',
    'urn:oid:0.9.2342.19200300.100.1.3', // mail
    'urn:oid:1.2.840.113549.1.9.1', // emailAddress
  ],
  name: [
    'displayName',
    'display_name',
    'name',
    'cn',
    'DisplayName',
    'http://schemas.microsoft.com/identity/claims/displayname',
    'urn:oid:2.16.840.1.113730.3.1.241', // displayName
    'urn:oid:2.5.4.3', // cn
  ],
  firstName: [
    'firstName',
    'first_name',
    'givenName',
    'given_name',
    'FirstName',
    'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname',
    'urn:oid:2.5.4.42',
  ],
  lastName: [
    'lastName',
    'last_name',
    'surname',
    'sn',
    'LastName',
    'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname',
    'urn:oid:2.5.4.4',
  ],
  groups: [
    'groups',
    'Groups',
    'memberOf',
    'member',
    'http://schemas.microsoft.com/ws/2008/06/identity/claims/groups',
    'http://schemas.xmlsoap.org/claims/Group',
    'urn:oid:1.3.6.1.4.1.5923.1.5.1.1', // isMemberOf
  ],
  /**
   * The user's id in the provider's DIRECTORY, which is not the same thing as
   * the NameID we store as `subject` (see services/directory/externalId.js
   * for the same trap on the OIDC side — Entra's `sub` is pairwise and
   * appears nowhere in Graph, and its SAML NameID has the same problem when
   * the app is configured for a persistent/pairwise identifier).
   *
   * Entra emits the Graph object id as the `objectidentifier` claim, so that
   * candidate is safe. Everything else is a guess, which is why nothing else
   * generic is listed: recording NOTHING is always safe (directory sync
   * treats a null external id as "we cannot judge this user"), recording the
   * WRONG id is not.
   */
  externalId: [
    'http://schemas.microsoft.com/identity/claims/objectidentifier',
    'objectGUID',
  ],
};

export const ATTRIBUTE_KEYS = Object.keys(DEFAULT_ATTRIBUTE_CANDIDATES);

/**
 * Per-preset overrides that go FIRST, ahead of the shared candidates. These
 * are the attribute a given IdP emits by default, so a stock setup needs no
 * manual mapping at all.
 */
export const PRESET_ATTRIBUTE_HINTS = {
  'saml-entra': {
    email: ['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress'],
    name: ['http://schemas.microsoft.com/identity/claims/displayname'],
    firstName: ['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname'],
    lastName: ['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname'],
    groups: ['http://schemas.microsoft.com/ws/2008/06/identity/claims/groups'],
    externalId: ['http://schemas.microsoft.com/identity/claims/objectidentifier'],
  },
  'saml-okta': {
    email: ['email'],
    name: ['displayName'],
    firstName: ['firstName'],
    lastName: ['lastName'],
    groups: ['groups'],
  },
  'saml-adfs': {
    email: ['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress'],
    name: ['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name'],
    firstName: ['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname'],
    lastName: ['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname'],
    groups: ['http://schemas.microsoft.com/ws/2008/06/identity/claims/groups'],
  },
};

/**
 * Build the ordered candidate list for one logical field.
 *
 * @param {string} key - email | name | firstName | lastName | groups | externalId
 * @param {object|null} mapping - SsoConfig.samlAttributeMapping
 * @param {string|null} presetId
 * @returns {string[]}
 */
export function candidatesFor(key, mapping, presetId = null) {
  const out = [];
  const configured = mapping && typeof mapping === 'object' ? mapping[key] : null;
  if (typeof configured === 'string' && configured.trim()) out.push(configured.trim());
  else if (Array.isArray(configured)) {
    for (const c of configured) if (typeof c === 'string' && c.trim()) out.push(c.trim());
  }
  for (const c of (PRESET_ATTRIBUTE_HINTS[presetId] || {})[key] || []) out.push(c);
  for (const c of DEFAULT_ATTRIBUTE_CANDIDATES[key] || []) out.push(c);
  return [...new Set(out)];
}

export default { DEFAULT_ATTRIBUTE_CANDIDATES, PRESET_ATTRIBUTE_HINTS, ATTRIBUTE_KEYS, candidatesFor };
