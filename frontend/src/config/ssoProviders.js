// Preset metadata for SSO identity providers — drives both the "Add provider"
// picker grid and the per-provider configuration form in Settings > SSO, plus
// icon selection on the Login page. `id` here is the DTO's `presetId`
// (google|entra|okta|auth0|generic|github) — keep these in sync with the
// backend contract in docs/auth-hardening.md.
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
    id: 'saml',
    label: 'SAML 2.0',
    protocol: 'saml',
    fields: ['metadataUrl'],
    description: 'SAML support is coming soon. Use OIDC for now if your IdP supports both.',
    disabled: true,
    setupSteps: [],
  },
];

export function getProvider(id) {
  return SSO_PROVIDERS.find((p) => p.id === id) || null;
}
