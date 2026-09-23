/**
 * externalId.js — what a sign-in tells us about the user's id in the
 * provider's DIRECTORY, as opposed to their id in this application.
 *
 * Directory sync asks each provider "who still works here?" and gets back a
 * list of directory ids. To decide whether a Shellius user is in that list we
 * need the same id for them, and `UserIdentity.subject` is not reliably it.
 *
 * The rule per provider:
 *
 *   github   `sub` is the numeric user id, which is exactly what
 *            GET /orgs/{org}/members returns. Safe.
 *   google   the OIDC `sub` is the immutable directory id, which is what the
 *            Admin SDK returns as `users.id`. Safe.
 *   entra    `sub` is PAIRWISE — unique per application — and appears nowhere
 *            in Microsoft Graph. The directory id is the `oid` claim. Using
 *            `sub` here would match nothing, which a deprovisioning job would
 *            read as "everybody has left".
 *   okta     `sub` is the user id on an org authorization server, but a custom
 *            authorization server defaults it to the user's login. We accept
 *            it only when it has Okta's user-id shape, and otherwise record
 *            nothing.
 *   generic  unknowable. We record nothing rather than guess.
 *
 * Returning null is always safe: sync treats an unknown directory id as "we
 * cannot judge this user" and leaves them alone. Returning a WRONG id is not
 * safe, which is why every branch here errs towards null.
 */

/** Okta assigns user ids as `00u` + 17 base-62 characters. */
const OKTA_USER_ID = /^00u[a-zA-Z0-9]{14,20}$/;

/**
 * @param {object} cfg - the SsoConfig row (`provider`, `presetId`)
 * @param {object} params
 * @param {string} params.subject - the `sub` we store on the identity
 * @param {object} [params.claims] - merged ID-token + userinfo claims
 * @returns {string|null} the directory id, or null if we cannot know it
 */
export function externalIdFor(cfg, { subject, claims = {} } = {}) {
  if (!subject) return null;
  const preset = cfg?.presetId || null;

  if (cfg?.provider === 'github') return String(subject);

  switch (preset) {
    case 'google':
      return String(subject);
    case 'entra': {
      // The only claim that is the Graph object id. Never fall back to `sub`.
      const oid = claims.oid || claims.xms_oid || null;
      return oid ? String(oid) : null;
    }
    case 'okta':
      return OKTA_USER_ID.test(String(subject)) ? String(subject) : null;
    default:
      return null;
  }
}

export default { externalIdFor };
