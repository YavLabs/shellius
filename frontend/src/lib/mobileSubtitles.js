/**
 * Phone page-header subtitles, keyed by page title. The phone header puts
 * the subtitle beside the icon, where roughly 30 characters fit on one
 * line, so pages get a short version here; anything not listed is cut to
 * one line (MobilePageHeader). Desktop keeps each page's full subtitle.
 */
export const MOBILE_SUBTITLES = {
  Dashboard: 'Your infrastructure at a glance',
  Connect: 'Servers, hosts or any address',
  Activity: 'What needs your attention',
  Servers: 'Target servers by customer',
  Customers: 'Tenants and their servers',
  'My hosts': 'Your private SSH targets',
  'Access Requests': 'Request and review access',
  Policies: 'Who can reach which servers',
  Certificates: 'Short-lived SSH certificates',
  Keystore: 'Stored identities and keys',
  Sessions: 'SSH and RDP sessions',
  'Audit Log': 'Every action, recorded',
  Notifications: 'Everything sent to you',
  'Recent connections': 'Your sessions and recent hosts',
  Administration: 'People, security, integrations',
  Users: 'Accounts and their roles',
  Roles: 'What each role can do',
  Groups: 'Users grouped for access',
  Profile: 'Your account and data',
  'Bulk Import': 'From CSV, JSON or ZIP',
  'Install the Shellius CLI': 'The terminal client',
};

/** The phone subtitle for a page: the short version when there is one. */
export function mobileSubtitle(title, subtitle) {
  if (typeof title === 'string' && MOBILE_SUBTITLES[title]) return MOBILE_SUBTITLES[title];
  return subtitle;
}
