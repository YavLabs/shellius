-- SAML 2.0 Web Browser SSO.
--
-- Until now `provider` could only be 'oidc' or 'github'. The API's Joi schema
-- accepted `provider: 'saml'`, but nothing anywhere could consume it: there
-- was no SAML library, no ACS endpoint and no metadata endpoint, so a config
-- saved that way was accepted and then silently unusable. These columns are
-- what a SAML row actually needs.
--
-- Every column is nullable or has a default, so no existing OIDC / GitHub row
-- changes. Nothing is backfilled.
--
-- client_id loses its NOT NULL because SAML has no client id. It stays
-- required by the API for every OIDC / GitHub provider — the constraint moves
-- from the database to the route's Joi schema, which is where the
-- per-protocol rules already live (issuer_url is required for OIDC there and
-- has never been NOT NULL here either). Dropping NOT NULL is a widening
-- change: every row that satisfied the old constraint still satisfies the new
-- one, so this is safe to run against a live database and safe to leave
-- applied if the feature is later rolled back.

ALTER TABLE "sso_configs" ALTER COLUMN "client_id" DROP NOT NULL;

ALTER TABLE "sso_configs"
  -- Where the AuthnRequest is sent (HTTP-Redirect binding).
  ADD COLUMN "saml_idp_entry_point"            TEXT,
  -- The IdP's EntityID. Every assertion's Issuer must equal this exactly;
  -- a valid signature from the configured key is not on its own a statement
  -- about who issued the assertion.
  ADD COLUMN "saml_idp_entity_id"              TEXT,
  -- The IdP's signing certificate(s): a JSON array of PEM strings, ENCRYPTED
  -- at rest with SERVER_ENCRYPTION_KEY (utils/crypto.js), like every other
  -- stored third-party secret. An array rather than one value so a
  -- certificate rotation can be staged — old and new both accepted — instead
  -- of requiring a flag-day cutover that locks an org out of its own tenant.
  -- Signatures are verified against these certificates ONLY. A certificate
  -- embedded in the assertion's own KeyInfo is never consulted, because a
  -- document that carries its own trust anchor proves nothing.
  ADD COLUMN "saml_idp_cert_encrypted"         TEXT,
  -- Our EntityID, which the assertion's AudienceRestriction must name.
  ADD COLUMN "saml_sp_entity_id"               TEXT,
  -- The SP key pair: signs AuthnRequests, decrypts EncryptedAssertions. The
  -- private key is encrypted at rest and is never returned by any API — the
  -- DTO exposes only a fingerprint and "we have one".
  ADD COLUMN "saml_sp_private_key_encrypted"   TEXT,
  ADD COLUMN "saml_sp_certificate"             TEXT,
  ADD COLUMN "saml_signature_algorithm"        TEXT,
  ADD COLUMN "saml_digest_algorithm"           TEXT,
  -- Whether the <Response> envelope must ALSO be signed. The <Assertion>
  -- signature is required unconditionally and is not configurable: accepting
  -- an unsigned assertion inside a signed response is the oldest hole in this
  -- protocol.
  ADD COLUMN "saml_want_authn_response_signed" BOOLEAN NOT NULL DEFAULT false,
  -- Unsolicited (IdP-initiated) sign-in. Off by default: without an
  -- InResponseTo there is no binding to a request we made, so replay
  -- protection rests entirely on assertion-ID tracking.
  ADD COLUMN "saml_allow_idp_initiated"        BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "saml_clock_skew_sec"             INTEGER NOT NULL DEFAULT 60,
  ADD COLUMN "saml_identifier_format"          TEXT,
  ADD COLUMN "saml_force_authn"                BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "saml_sign_requests"              BOOLEAN NOT NULL DEFAULT true,
  -- { email, name, firstName, lastName, groups, externalId } -> assertion
  -- attribute Names. NULL means "use the built-in defaults", which cover the
  -- claim URIs Entra, Okta, ADFS and Shibboleth emit.
  ADD COLUMN "saml_attribute_mapping"          JSONB;
