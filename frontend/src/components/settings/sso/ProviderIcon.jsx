import { Building2, Shield, Cloud, Key, Globe, FileKey, Github } from 'lucide-react';

/**
 * Map a preset id (Google, Entra, Okta, Auth0, GitHub, Generic OIDC, SAML) to
 * a Lucide icon component. Shared by the SSO provider picker/list in
 * Settings, the Login page provider buttons, and the Sign-in methods card.
 */
const ICONS = {
  google: Cloud,
  entra: Building2,
  okta: Shield,
  auth0: Key,
  github: Github,
  generic: Globe,
  'generic-oidc': Globe, // legacy id, kept for safety
  saml: FileKey,
  'saml-entra': FileKey,
  'saml-okta': FileKey,
  'saml-adfs': FileKey,
};

export default function ProviderIcon({ presetId, className }) {
  const Icon = ICONS[presetId] || Globe;
  return <Icon className={className} aria-hidden="true" />;
}
