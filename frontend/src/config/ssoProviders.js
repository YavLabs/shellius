// Preset metadata for SSO identity providers — drives both the "Add provider"
// picker grid and the per-provider configuration form in Administration → Single sign-on, plus
// icon selection on the Login page. `id` here is the DTO's `presetId`
// (google|entra|okta|auth0|generic|github|saml|saml-entra|saml-okta|saml-adfs)
// — keep these in sync with the backend contract in docs/auth-hardening.md and
// with PRESET_IDS in backend/src/routes/sso.js.
//
// `protocol: 'saml'` switches ProviderForm to its SAML branch; the SAML
// presets carry no `fields` list because that branch renders a fixed set of
// SAML fields rather than a preset-driven one. The four SAML preset ids are
// NOT cosmetic: backend/src/config/samlAttributes.js keys its per-IdP
// attribute-name hints off them, so picking "Okta (SAML)" is what makes a
// stock Okta app work with no manual attribute mapping at all.
export const SSO_PROVIDERS = [
  {
    id: 'google',
    label: 'Google Workspace',
    protocol: 'oidc',
    issuerUrl: 'https://accounts.google.com',
    defaultScopes: 'openid email profile',
    fields: ['clientId', 'clientSecret'],
    description: 'Sign in with Google Workspace accounts via OAuth 2.0 / OIDC.',
    setupSteps: [
      {
        title: 'Open Google Cloud Console',
        body: 'Go to https://console.cloud.google.com/apis/credentials and select your project (or create one).',
      },
      {
        title: 'Create OAuth 2.0 Client ID',
        body: 'Click "Create credentials" -> "OAuth client ID" -> Application type: "Web application".',
      },
      {
        title: 'Add the callback URL',
        body: 'Paste the callback URL shown below into "Authorized redirect URIs".',
      },
      {
        title: 'Copy the Client ID and Client Secret',
        body: 'After creation, copy both values into the form below.',
      },
      {
        title: 'Optional: Restrict to your domain',
        body: 'In OAuth consent screen settings, set User Type to "Internal" to restrict logins to your Workspace org.',
      },
    ],
  },
  {
    id: 'entra',
    label: 'Microsoft Entra ID (Azure AD)',
    protocol: 'oidc',
    fields: ['tenantId', 'clientId', 'clientSecret'],
    defaultScopes: 'openid email profile',
    description: 'Sign in with Microsoft Entra ID (formerly Azure Active Directory) accounts.',
    deriveIssuerUrl: ({ tenantId }) =>
      `https://login.microsoftonline.com/${tenantId}/v2.0`,
    setupSteps: [
      {
        title: 'Open Microsoft Entra admin center',
        body: 'Go to https://entra.microsoft.com -> Identity -> Applications -> App registrations.',
      },
      {
        title: 'New registration',
        body: 'Click "New registration". Name: "Shellius". Supported account types: "Accounts in this organizational directory only".',
      },
      {
        title: 'Add a Web platform with the callback URL',
        body: 'Under "Authentication" -> "Add a platform" -> "Web" -> paste the callback URL shown below.',
      },
      {
        title: 'Add a client secret',
        body: 'Under "Certificates & secrets" -> "New client secret" -> copy the Value (not the Secret ID).',
      },
      {
        title: 'Copy the Application (client) ID and Directory (tenant) ID',
        body: 'From the Overview page. Paste both into the form below.',
      },
    ],
  },
  {
    id: 'okta',
    label: 'Okta',
    protocol: 'oidc',
    fields: ['oktaDomain', 'clientId', 'clientSecret'],
    defaultScopes: 'openid email profile groups',
    description: 'Sign in with Okta Workforce Identity.',
    deriveIssuerUrl: ({ oktaDomain }) =>
      `https://${oktaDomain}/oauth2/default`,
    setupSteps: [
      {
        title: 'Open Okta admin console',
        body: 'Go to your Okta admin URL -> Applications -> Applications -> Create App Integration.',
      },
      {
        title: 'Pick OIDC + Web Application',
        body: 'Sign-in method: "OIDC - OpenID Connect". Application type: "Web Application".',
      },
      {
        title: 'Set Sign-in redirect URI',
        body: 'Paste the callback URL shown below.',
      },
      {
        title: 'Assign users / groups',
        body: 'Under Assignments, choose who can use this integration.',
      },
      {
        title: 'Copy Client ID + Secret + your Okta domain',
        body: 'e.g. "acme.okta.com". Paste into the form below.',
      },
    ],
  },
  {
    id: 'auth0',
    label: 'Auth0',
    protocol: 'oidc',
    fields: ['auth0Domain', 'clientId', 'clientSecret'],
    defaultScopes: 'openid email profile',
    description: 'Sign in with Auth0 (Okta CIC).',
    deriveIssuerUrl: ({ auth0Domain }) => `https://${auth0Domain}/`,
    setupSteps: [
      {
        title: 'Open Auth0 dashboard',
        body: 'Go to https://manage.auth0.com -> Applications -> Create Application -> "Regular Web Application".',
      },
      {
        title: 'Configure Allowed Callback URLs',
        body: 'Paste the callback URL shown below into "Allowed Callback URLs".',
      },
      {
        title: 'Save changes',
        body: 'Click "Save Changes" at the bottom of the page.',
      },
      {
        title: 'Copy Domain + Client ID + Client Secret',
        body: 'From the Settings tab. Paste into the form below.',
      },
    ],
  },
  {
    id: 'github',
    label: 'GitHub',
    protocol: 'github',
    fields: ['clientId', 'clientSecret'],
    defaultScopes: 'read:user user:email',
    description: 'Sign in with GitHub or GitHub Enterprise accounts via OAuth.',
    setupSteps: [
      {
        title: 'Register an OAuth App',
        body: 'On github.com (or your GHE instance): Settings -> Developer settings -> OAuth Apps -> New OAuth App.',
      },
      {
        title: 'Set the callback URL',
        body: 'Paste the callback URL shown below into "Authorization callback URL".',
      },
      {
        title: 'Copy the Client ID and generate a Client Secret',
        body: 'Paste both into the form below.',
      },
      {
        title: 'Optional: restrict to GitHub organizations',
        body: 'Add allowed organizations below. Shellius checks org membership with the read:org scope, so members must have public or Shellius-visible org membership.',
      },
    ],
  },
  {
    id: 'generic',
    label: 'Generic OIDC',
    protocol: 'oidc',
    fields: ['issuerUrl', 'clientId', 'clientSecret', 'scopes'],
    defaultScopes: 'openid email profile',
    description: 'Any OIDC-compliant identity provider with a discovery document.',
    setupSteps: [
      {
        title: "Find your IdP's OIDC discovery URL",
        body: 'It usually ends in /.well-known/openid-configuration. Paste the issuer URL (without the /.well-known suffix).',
      },
      {
        title: 'Register Shellius as a client',
        body: 'In your IdP, create a confidential web client and copy the Client ID and Client Secret.',
      },
      {
        title: 'Configure the callback URL',
        body: "Paste the callback URL shown below into your IdP's allowed redirect URIs.",
      },
      {
        title: 'Adjust scopes if needed',
        body: 'Most IdPs accept "openid email profile" by default.',
      },
    ],
  },
  {
    id: 'saml-entra',
    label: 'Microsoft Entra ID (SAML)',
    protocol: 'saml',
    fields: [],
    description: 'Entra ID / Azure AD via SAML 2.0, using the Microsoft claim URIs by default.',
    setupSteps: [
      {
        title: 'Create an Enterprise application',
        body: 'Entra admin center -> Identity -> Applications -> Enterprise applications -> New application -> "Create your own application" -> "Integrate any other application you don\'t find in the gallery".',
      },
      {
        title: 'Open Single sign-on -> SAML',
        body: 'Under "Basic SAML Configuration", click Edit.',
      },
      {
        title: 'Paste the Service Provider values',
        body: 'Identifier (Entity ID) = the EntityID shown below. Reply URL (Assertion Consumer Service URL) = the ACS URL shown below. Leave "Sign on URL" blank so sign-in starts from Shellius.',
      },
      {
        title: 'Download the Base64 signing certificate',
        body: 'Section 3, "SAML Certificates" -> Certificate (Base64). Open it in a text editor and paste the whole file into the IdP signing certificate box below.',
      },
      {
        title: 'Copy the login URL and the Microsoft Entra Identifier',
        body: 'Section 4. "Login URL" goes in IdP sign-in URL; "Microsoft Entra Identifier" (https://sts.windows.net/<tenant>/) goes in IdP EntityID.',
      },
      {
        title: 'Assign users or groups',
        body: 'Back on the application, Users and groups -> Add user/group. Entra only issues an assertion for assigned users.',
      },
    ],
  },
  {
    id: 'saml-okta',
    label: 'Okta (SAML)',
    protocol: 'saml',
    fields: [],
    description: 'Okta Workforce Identity via SAML 2.0, using Okta\'s short attribute names by default.',
    setupSteps: [
      {
        title: 'Create a SAML app integration',
        body: 'Okta admin console -> Applications -> Applications -> Create App Integration -> "SAML 2.0".',
      },
      {
        title: 'Paste the Service Provider values',
        body: 'Single sign-on URL = the ACS URL shown below. Audience URI (SP Entity ID) = the EntityID shown below.',
      },
      {
        title: 'Set the Name ID format',
        body: 'Name ID format: EmailAddress (or Persistent). Do not use Transient — it changes on every sign-in and Shellius refuses it.',
      },
      {
        title: 'Add attribute statements',
        body: 'Add email, firstName, lastName and displayName (and groups, if you want them recorded). The defaults below already look for those names.',
      },
      {
        title: 'Copy the IdP values',
        body: 'On the Sign On tab, "View SAML setup instructions" gives the Identity Provider Single Sign-On URL, the Identity Provider Issuer and the X.509 certificate. Paste all three below.',
      },
      {
        title: 'Assign people',
        body: 'Assignments tab -> Assign to people or groups.',
      },
    ],
  },
  {
    id: 'saml-adfs',
    label: 'AD FS (SAML)',
    protocol: 'saml',
    fields: [],
    description: 'On-premise Active Directory Federation Services via SAML 2.0.',
    setupSteps: [
      {
        title: 'Add a Relying Party Trust',
        body: 'AD FS Management -> Relying Party Trusts -> Add Relying Party Trust -> Claims aware. Choose "Import data about the relying party published online" and paste the metadata URL shown below — AD FS then fills in the EntityID, ACS URL and our signing certificate for you.',
      },
      {
        title: 'Or enter the values by hand',
        body: 'If the metadata URL is not reachable from the AD FS server, use Manual: Identifier = the EntityID below, and add a SAML 2.0 WebSSO endpoint pointing at the ACS URL below.',
      },
      {
        title: 'Add claim rules',
        body: 'Issue "E-Mail-Address", "Given-Name", "Surname" and "Display Name" as the standard schemas.xmlsoap.org claim URIs, then a rule that transforms E-Mail-Address into the Name ID with format "Email".',
      },
      {
        title: 'Copy the AD FS values',
        body: 'IdP sign-in URL is https://<adfs-host>/adfs/ls/. IdP EntityID is usually http://<adfs-host>/adfs/services/trust. The token-signing certificate is under Service -> Certificates -> export the Base-64 file.',
      },
      {
        title: 'Check the signature algorithm',
        body: 'AD FS defaults to SHA-256, which matches Shellius. Only lower the floor below if this farm is pinned to SHA-1.',
      },
    ],
  },
  {
    id: 'saml',
    label: 'Generic SAML 2.0',
    protocol: 'saml',
    fields: [],
    description: 'Any SAML 2.0 identity provider, using HTTP-Redirect for requests and HTTP-POST for the assertion.',
    setupSteps: [
      {
        title: 'Register Shellius as a Service Provider',
        body: 'Either import the SP metadata URL shown below, or enter the EntityID and ACS URL by hand. The assertion must be POSTed to the ACS URL — Shellius does not accept the HTTP-Redirect or Artifact bindings inbound.',
      },
      {
        title: 'Sign the assertion',
        body: 'Shellius always requires a signature over the assertion itself; a signature over the response envelope alone is refused. Signing the response too is optional and is a toggle below.',
      },
      {
        title: 'Choose a stable NameID',
        body: 'Persistent or emailAddress. A transient NameID is refused: it changes on every sign-in, so it cannot identify a returning user.',
      },
      {
        title: 'Paste the IdP values',
        body: 'The single sign-on URL (HTTP-Redirect), the IdP EntityID exactly as it appears in the assertion\'s Issuer, and the signing certificate.',
      },
      {
        title: 'Map attributes if your IdP uses unusual names',
        body: 'Shellius already tries the common names and OIDs. Only fill in the attribute mapping below if a sign-in fails because the email or name could not be found.',
      },
    ],
  },
];

export function getProvider(id) {
  return SSO_PROVIDERS.find((p) => p.id === id) || null;
}
