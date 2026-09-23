/**
 * Permission catalogue — the single source of truth for what a role can do.
 *
 * Every API capability that used to be gated by a hard-coded role list is a
 * permission here. Roles (system or custom, see Role in schema.prisma) are
 * just sets of these keys. The built-in roles are seeded from `defaults`.
 *
 * Fields
 *   key          stable identifier stored on roles — never rename, only add
 *   group        UI grouping on the role editor
 *   label        short human label
 *   description  what holding it lets you do (shown in the role editor)
 *   sensitive    high-impact: shown with a warning in the role editor
 *   defaults     built-in roles (by base tier) that get it on a fresh install
 *   current      which roles had the capability BEFORE permissions existed
 *                (documentation for docs/rbac/permission-matrix.csv)
 *   endpoints    API endpoints it gates (documentation)
 *   findings     audit findings in docs/rbac/rbac-audit.md it relates to
 *   since        catalogue version that introduced it — new permissions are
 *                added to existing roles on boot per their base tier
 */

export const TIERS = ['member', 'manager', 'admin', 'super_admin'];

const M = ['member', 'manager', 'admin', 'super_admin'];
const MGR = ['manager', 'admin', 'super_admin'];
const ADM = ['admin', 'super_admin'];
const SA = ['super_admin'];

export const PERMISSION_GROUPS = [
  { key: 'inventory', label: 'Customers & servers' },
  { key: 'access', label: 'Server access' },
  { key: 'quick_connect', label: 'Quick Connect' },
  { key: 'certificates', label: 'Certificates & CA' },
  { key: 'policies', label: 'Policies & groups' },
  { key: 'sessions', label: 'Sessions & audit' },
  { key: 'keystore', label: 'Keystore' },
  { key: 'vault', label: 'Personal vault' },
  { key: 'users', label: 'Users' },
  { key: 'roles', label: 'Roles' },
  { key: 'tokens', label: 'API tokens & service accounts' },
  { key: 'posture', label: 'Exposure posture' },
  { key: 'settings', label: 'Organization & settings' },
];

export const PERMISSIONS = [
  // ---------------------------------------------------------------- inventory
  {
    key: 'customers.view',
    group: 'inventory',
    label: 'View customers',
    description: 'See customers and their server counts.',
    defaults: M,
    current: M,
    endpoints: ['GET /api/customers', 'GET /api/customers/:id', 'GET /api/customers/:id/stats'],
  },
  {
    key: 'customers.create',
    group: 'inventory',
    label: 'Create customers',
    description: 'Add new customers.',
    defaults: MGR,
    current: MGR,
    endpoints: ['POST /api/customers'],
  },
  {
    key: 'customers.update',
    group: 'inventory',
    label: 'Edit customers',
    description: 'Rename customers and activate / deactivate them.',
    defaults: MGR,
    current: MGR,
    endpoints: ['PUT /api/customers/:id'],
  },
  {
    key: 'customers.delete',
    group: 'inventory',
    label: 'Delete customers',
    description: 'Permanently delete a customer (its servers must be reassigned or deleted).',
    sensitive: true,
    defaults: SA,
    current: SA,
    endpoints: ['GET /api/customers/:id/delete-impact', 'DELETE /api/customers/:id'],
    findings: ['F-13', 'UI-2.2'],
  },
  {
    key: 'servers.view',
    group: 'inventory',
    label: 'View servers',
    description: 'See the server inventory and fleet health.',
    defaults: M,
    current: M,
    endpoints: ['GET /api/servers', 'GET /api/servers/:id', 'GET /api/servers/health/summary'],
  },
  {
    key: 'servers.create',
    group: 'inventory',
    label: 'Add servers',
    description: 'Add servers to the inventory.',
    defaults: MGR,
    current: MGR,
    endpoints: ['POST /api/servers'],
  },
  {
    key: 'servers.update',
    group: 'inventory',
    label: 'Edit servers',
    description: 'Edit server name, address, port, labels, customer, OS and SSH user (single or bulk).',
    defaults: MGR,
    current: MGR,
    endpoints: ['PUT /api/servers/:id', 'POST /api/servers/bulk'],
  },
  {
    key: 'servers.change_environment',
    group: 'inventory',
    label: 'Change server environment',
    description:
      'Move servers between demo / dev / staging / prod. Moving a server out of prod removes its approval requirement.',
    sensitive: true,
    defaults: ADM,
    current: MGR,
    endpoints: ['POST /api/servers/bulk/environment', 'PUT /api/servers/:id (environment)', 'POST /api/servers/bulk (environment)'],
    findings: ['F-05'],
  },
  {
    key: 'servers.manage_credentials',
    group: 'inventory',
    label: 'Bind stored identities to servers',
    description: 'Switch a server to identity auth, pick its Keystore identity, or set its RDP password.',
    sensitive: true,
    defaults: ADM,
    current: MGR,
    endpoints: ['POST/PUT /api/servers (authMode, credentialId, rdpPassword)', 'POST /api/quick-connect/save (existing identity)'],
    findings: ['F-05', 'F-17'],
  },
  {
    key: 'servers.update_connection_ip',
    group: 'inventory',
    label: 'Update dynamic IP',
    description: 'Change the connection IP of a server marked as having a dynamic IP.',
    defaults: MGR,
    current: M,
    endpoints: ['PATCH /api/servers/:id/connection-ip'],
    findings: ['F-06'],
  },
  {
    key: 'servers.onboard',
    group: 'inventory',
    label: 'Onboard servers',
    description: 'Create install / uninstall links, run remote provisioning and health checks.',
    defaults: MGR,
    current: MGR,
    endpoints: [
      'POST /api/bootstrap/token',
      'POST /api/bootstrap/uninstall-token',
      'POST /api/servers/:id/provision',
      'POST /api/servers/:id/health-check',
    ],
  },
  {
    key: 'servers.reset_host_key',
    group: 'inventory',
    label: 'Reset pinned host keys',
    description: 'Clear a server’s pinned SSH host key so the next connection trusts a new one.',
    sensitive: true,
    defaults: ADM,
    current: ADM,
    endpoints: ['POST /api/servers/:id/host-key/reset'],
  },
  {
    key: 'servers.delete',
    group: 'inventory',
    label: 'Delete servers',
    description: 'Permanently delete servers.',
    sensitive: true,
    defaults: SA,
    current: SA,
    endpoints: ['GET /api/servers/:id/delete-impact', 'DELETE /api/servers/:id'],
    findings: ['UI-2.1'],
  },
  {
    key: 'import.run',
    group: 'inventory',
    label: 'Bulk import',
    description: 'Import customers, servers, users, groups and policies from CSV/JSON. Each row type also needs the matching permission.',
    defaults: ADM,
    current: ADM,
    endpoints: ['POST /api/import', 'GET /api/import/:id', 'PATCH /api/import/:id/decisions', 'POST /api/import/:id/commit', 'GET /api/import/templates/:entity'],
    findings: ['F-01', 'F-25'],
  },

  // ------------------------------------------------------------------- access
  {
    key: 'access.request',
    group: 'access',
    label: 'Request access',
    description: 'Request access to servers. What is granted still depends on access policies.',
    defaults: M,
    current: M,
    endpoints: ['POST /api/access-requests', 'GET /api/policies/my-access'],
  },
  {
    key: 'access.choose_principal',
    group: 'access',
    label: 'Choose login user',
    description: 'Request or connect as any login user the matching policy allows, not just the server default.',
    defaults: ADM,
    current: ADM,
    endpoints: ['POST /api/access-requests (principal)', 'WS /api/terminal/ssh (principal override)'],
    findings: ['F-18', 'G14'],
  },
  {
    key: 'access.prod_bypass',
    group: 'access',
    label: 'Production without approval',
    description:
      'Get production access without an approver. The request is still created (reason required), audited as access_request.prod_bypass, and approvers are notified.',
    sensitive: true,
    defaults: ADM,
    current: ADM,
    endpoints: ['POST /api/access-requests (prod)'],
    findings: ['F-09', 'G3', 'G5'],
  },
  {
    key: 'access.bypass_policies',
    group: 'access',
    label: 'Bypass access policies',
    description: 'Non-production access to any server without a matching policy (DENY policies still apply).',
    sensitive: true,
    defaults: SA,
    current: SA,
    endpoints: ['POST /api/access-requests (non-prod)'],
    findings: ['G12'],
  },
  {
    key: 'access.break_glass',
    delegable: false,
    group: 'access',
    label: 'Break-glass access',
    description:
      "Self-approve emergency access to a server a break-glass policy names for you, up to that policy's max duration, after step-up verification (authenticator app or emailed one-time code). Always audited as high severity and all admins are notified.",
    sensitive: true,
    defaults: ADM,
    current: ADM,
    endpoints: ['POST /api/access-requests/break-glass/start', 'POST /api/access-requests/break-glass/verify'],
    findings: ['F-09', 'G5', 'G7'],
  },
  {
    key: 'access_requests.view_all',
    group: 'access',
    label: 'View all access requests',
    description: 'See every access request in the organization, not just your own and the ones you review.',
    defaults: ADM,
    current: ADM,
    endpoints: ['GET /api/access-requests?tab=all', 'GET /api/access-requests/:id'],
  },
  {
    key: 'access_requests.revoke_any',
    group: 'access',
    label: 'Revoke any access',
    description: 'Revoke any approved access request (and its certificate).',
    defaults: ADM,
    current: ADM,
    endpoints: ['POST /api/access-requests/:id/revoke'],
    findings: ['F-07', 'UI-2.10'],
  },

  // ------------------------------------------------------------ quick connect
  {
    key: 'quick_connect.use',
    group: 'quick_connect',
    label: 'Use Quick Connect',
    description: 'Open ad-hoc SSH sessions with one-off credentials to hosts that are not saved production servers.',
    defaults: MGR,
    current: MGR,
    endpoints: ['POST /api/quick-connect/tickets', 'POST /api/quick-connect/history/:id/reconnect'],
    findings: ['G6'],
  },
  {
    key: 'quick_connect.use_stored_identity',
    group: 'quick_connect',
    label: 'Quick Connect with stored identities',
    description: 'Use Keystore identities (stored passwords / keys) in Quick Connect.',
    sensitive: true,
    defaults: ADM,
    current: MGR,
    endpoints: ['POST /api/quick-connect/tickets (auth.type=credential)'],
    findings: ['F-17'],
  },
  {
    key: 'quick_connect.save_server',
    group: 'quick_connect',
    label: 'Save Quick Connect host as server',
    description: 'Turn a Quick Connect target into a saved server.',
    defaults: MGR,
    current: MGR,
    endpoints: ['POST /api/quick-connect/save'],
  },
  {
    key: 'quick_connect.settings',
    group: 'quick_connect',
    label: 'Quick Connect settings',
    description: 'Turn Quick Connect on or off for the organization.',
    defaults: ADM,
    current: ADM,
    endpoints: ['PUT /api/quick-connect/settings'],
  },

  // ------------------------------------------------------------- certificates
  {
    key: 'certificates.view_all',
    group: 'certificates',
    label: 'View all certificates',
    description: 'See every issued certificate. Everyone can always see their own.',
    defaults: ADM,
    current: ADM,
    endpoints: ['GET /api/certificates', 'GET /api/certificates/:id'],
  },
  {
    key: 'certificates.revoke',
    group: 'certificates',
    label: 'Revoke certificates',
    description: 'Revoke any issued certificate.',
    defaults: ADM,
    current: ADM,
    endpoints: ['POST /api/certificates/:id/revoke'],
  },
  {
    key: 'certificates.issue_direct',
    group: 'certificates',
    label: 'Issue certificates directly',
    description:
      'Sign a certificate outside the access-request flow (API only). Every principal is still checked against policy for the target server; production always needs an approved request.',
    sensitive: true,
    defaults: SA,
    current: M,
    endpoints: ['POST /api/certificates/issue'],
    findings: ['F-03', 'F-04', 'G1', 'G2'],
  },
  {
    key: 'ca.view',
    group: 'certificates',
    label: 'View CA',
    description: 'See the CA public key and status (needed to trust Shellius certificates on hosts manually).',
    defaults: ADM,
    current: ADM,
    endpoints: ['GET /api/ca/public-key', 'GET /api/ca/status'],
    findings: ['UI-3.4'],
  },
  {
    key: 'ca.rotate',
    delegable: false,
    group: 'certificates',
    label: 'Rotate CA',
    description: 'Rotate the organization’s certificate authority key pair.',
    sensitive: true,
    defaults: SA,
    current: SA,
    endpoints: ['POST /api/ca/rotate'],
  },

  // ------------------------------------------------------ policies and groups
  {
    key: 'policies.view',
    group: 'policies',
    label: 'View policies',
    description: 'See access policies and test them with the policy simulator.',
    defaults: ADM,
    current: ADM,
    endpoints: ['GET /api/policies', 'GET /api/policies/:id', 'POST /api/policies/evaluate'],
    findings: ['F-22'],
  },
  {
    key: 'policies.manage',
    group: 'policies',
    label: 'Manage policies',
    description: 'Create, edit and delete access policies — who can reach which servers, for how long, and who approves.',
    sensitive: true,
    defaults: ADM,
    current: ADM,
    endpoints: ['POST /api/policies', 'PUT /api/policies/:id', 'DELETE /api/policies/:id', 'GET /api/policies/:id/delete-impact'],
  },
  {
    key: 'groups.view',
    group: 'policies',
    label: 'View groups',
    description: 'See groups and their members.',
    defaults: MGR,
    current: MGR,
    endpoints: ['GET /api/groups', 'GET /api/groups/:id'],
    findings: ['UI-3.3'],
  },
  {
    key: 'groups.manage',
    group: 'policies',
    label: 'Manage groups',
    description: 'Create, edit and delete groups and change their members (groups are used by policies and approvals).',
    defaults: ADM,
    current: ADM,
    endpoints: ['POST /api/groups', 'PUT /api/groups/:id', 'DELETE /api/groups/:id', 'POST /api/groups/:id/members', 'DELETE /api/groups/:id/members/:userId'],
  },

  // ------------------------------------------------------- sessions and audit
  {
    key: 'sessions.view_all',
    group: 'sessions',
    label: 'View all sessions',
    description: 'See every user’s SSH / RDP sessions, live and past.',
    defaults: MGR,
    current: MGR,
    endpoints: ['GET /api/sessions', 'GET /api/sessions/active', 'GET /api/sessions/:id'],
    findings: ['UI-2.7'],
  },
  {
    key: 'sessions.view_recordings',
    group: 'sessions',
    label: 'Watch session recordings',
    description: 'Download and replay any session recording.',
    sensitive: true,
    defaults: ADM,
    current: MGR,
    endpoints: ['GET /api/sessions/:id/recording'],
    findings: ['F-22'],
  },
  {
    key: 'sessions.terminate',
    group: 'sessions',
    label: 'Terminate sessions',
    description: 'Force-end another user’s live session.',
    defaults: ADM,
    current: ADM,
    endpoints: ['POST /api/sessions/:id/terminate'],
  },
  {
    key: 'audit.view',
    group: 'sessions',
    label: 'View audit log',
    description: 'Read the organization audit log.',
    defaults: ADM,
    current: ADM,
    endpoints: ['GET /api/audit'],
  },
  {
    key: 'audit.export',
    group: 'sessions',
    label: 'Export audit log',
    description: 'Export the audit log as CSV / JSON.',
    sensitive: true,
    defaults: SA,
    current: SA,
    endpoints: ['GET /api/audit/export'],
  },

  // ----------------------------------------------------------------- keystore
  {
    key: 'keystore.view',
    group: 'keystore',
    label: 'View Keystore',
    description: 'See stored identities, keys and deployments (never secrets).',
    defaults: MGR,
    current: MGR,
    endpoints: ['GET /api/keystore/keys', 'GET /api/keystore/credentials', 'GET /api/keystore/deployments', 'POST /api/keystore/keys/inspect'],
  },
  {
    key: 'keystore.test',
    group: 'keystore',
    label: 'Test identities',
    description: 'Test a stored identity against a saved server. Testing against an arbitrary host needs Manage Keystore.',
    defaults: MGR,
    current: MGR,
    endpoints: ['POST /api/keystore/credentials/:id/test'],
    findings: ['F-17'],
  },
  {
    key: 'keystore.manage',
    group: 'keystore',
    label: 'Manage Keystore',
    description: 'Create, import, edit and delete stored identities and keys.',
    sensitive: true,
    defaults: ADM,
    current: ADM,
    endpoints: [
      'POST /api/keystore/keys/generate',
      'POST /api/keystore/keys/import',
      'PATCH/DELETE /api/keystore/keys/:id',
      'POST/PATCH/DELETE /api/keystore/credentials',
    ],
  },
  {
    key: 'keystore.export_private',
    delegable: false,
    group: 'keystore',
    label: 'Export private keys',
    description: 'Download a stored private key in plain text. Always audited.',
    sensitive: true,
    defaults: ADM,
    current: ADM,
    endpoints: ['POST /api/keystore/keys/:id/export'],
    findings: ['F-09'],
  },
  {
    key: 'keystore.deploy',
    group: 'keystore',
    label: 'Deploy keys to servers',
    description: 'Push, rotate and remove stored keys on servers. Production servers also need Production without approval.',
    sensitive: true,
    defaults: ADM,
    current: ADM,
    endpoints: ['POST /api/keystore/deployments', 'POST /api/keystore/deployments/:id/retry'],
    findings: ['F-09'],
  },

  // ------------------------------------------------------------ personal vault
  // docs/personal-vault.md — private to each user; nobody else can see or use
  // a personal item. Org switch: Organization.settings.vault.enabled.
  {
    key: 'vault.use',
    group: 'vault',
    label: 'Personal vault',
    description:
      'Keep private identities and SSH keys that only you can see, and use them in Quick Connect and My hosts. They can never be bound to org servers.',
    defaults: M,
    current: [],
    endpoints: [
      'GET/POST /api/keystore/credentials?scope=personal',
      'GET/POST /api/keystore/keys?scope=personal',
      'PATCH/DELETE/export/test on your own personal items',
    ],
    since: 2,
  },
  {
    key: 'vault.hosts',
    group: 'vault',
    label: 'My hosts',
    description:
      'Save your own SSH hosts and connect to them. Same guards as Quick Connect: production servers are refused, DENY policies apply, sessions are audited and recorded.',
    defaults: M,
    current: [],
    endpoints: ['GET/POST/PATCH/DELETE /api/vault/hosts', 'POST /api/vault/hosts/:id/connect'],
    since: 2,
  },

  // -------------------------------------------------------------------- users
  {
    key: 'users.view',
    group: 'users',
    label: 'View users',
    description: 'See the user directory.',
    defaults: ADM,
    current: ADM,
    endpoints: ['GET /api/users', 'GET /api/users/:id', 'GET /api/users/:id/reports', 'GET /api/users/:id/effective-scope'],
  },
  {
    key: 'users.view_reports',
    group: 'users',
    label: 'View own direct reports',
    description: 'See the users who report to you (you are their fallback approver).',
    defaults: MGR,
    current: ADM,
    endpoints: ['GET /api/users/:id/reports (self)', 'GET /api/users/:id (own reports)'],
    findings: ['F-22'],
  },
  {
    key: 'users.invite',
    group: 'users',
    label: 'Invite users',
    description: 'Create users and send or resend invitations.',
    defaults: ADM,
    current: ADM,
    endpoints: ['POST /api/users', 'POST /api/users/:id/resend-invite'],
    findings: ['F-02'],
  },
  {
    key: 'users.update',
    group: 'users',
    label: 'Edit users',
    description: 'Edit other users’ name, email, manager and SSH key. Only for users whose role you could assign.',
    defaults: ADM,
    current: ADM,
    endpoints: ['PUT /api/users/:id', 'PUT/DELETE /api/users/:id/ssh-key'],
    findings: ['F-01'],
  },
  {
    key: 'users.assign_role',
    delegable: false,
    group: 'users',
    label: 'Assign roles',
    description: 'Change users’ roles. You can only assign roles whose permissions you hold yourself.',
    sensitive: true,
    defaults: ADM,
    current: ADM,
    endpoints: ['PUT /api/users/:id (roleId)', 'POST /api/users (roleId)'],
    findings: ['F-01'],
  },
  {
    key: 'users.suspend',
    group: 'users',
    label: 'Suspend users',
    description: 'Suspend or reactivate users (signs them out everywhere).',
    defaults: ADM,
    current: ADM,
    endpoints: ['PUT /api/users/:id (status)'],
    findings: ['F-01', 'F-11'],
  },
  {
    key: 'users.reset_credentials',
    delegable: false,
    group: 'users',
    label: 'Reset passwords & lockouts',
    description: 'Send password-reset links and clear login lockouts.',
    sensitive: true,
    defaults: ADM,
    current: ADM,
    endpoints: ['POST /api/users/:id/password-reset', 'POST /api/users/:id/unlock'],
    findings: ['F-02'],
  },
  {
    key: 'users.revoke_sessions',
    group: 'users',
    label: 'Sign users out',
    description: 'Sign a user out of every browser and CLI session.',
    defaults: ADM,
    current: ADM,
    endpoints: ['POST /api/users/:id/revoke-sessions'],
  },
  {
    key: 'users.delete',
    delegable: false,
    group: 'users',
    label: 'Delete users',
    description: 'Permanently delete users.',
    sensitive: true,
    defaults: SA,
    current: SA,
    endpoints: ['GET /api/users/:id/delete-impact', 'DELETE /api/users/:id'],
    findings: ['UI-2.3'],
  },

  {
    key: 'users.manage_identities',
    delegable: false,
    group: 'users',
    label: 'Manage sign-in methods',
    description:
      'See whether a user has a password and which SSO accounts are linked to them, and unlink an SSO account. Only for users whose role you could assign; the last way to sign in can never be removed.',
    sensitive: true,
    defaults: ADM,
    current: [],
    endpoints: ['GET /api/users/:id/identities', 'DELETE /api/users/:id/identities/:identityId'],
    since: 3,
  },
  {
    key: 'users.assign_scope',
    group: 'users',
    label: 'Assign customer scope',
    description:
      'Restrict a user or group to a set of customers (docs/rbac/customer-scope-spec.md). Super admins can never be scoped. You can only grant customers within your own scope.',
    sensitive: true,
    defaults: ADM,
    current: [],
    endpoints: ['PUT /api/users/:id/scope', 'PUT /api/groups/:id/scope'],
    since: 4,
  },

  // ------------------------------------------------------------------ posture
  {
    key: 'posture.read',
    group: 'posture',
    label: 'View exposure posture',
    description:
      'See what a host exposes: listening ports and their owners, firewall state, running services, resource gauges, and open exposure findings (docs/posture/posture-spec.md).',
    defaults: M,
    current: [],
    endpoints: ['GET /api/posture/findings', 'GET /api/posture/servers/:id'],
    since: 5,
  },
  {
    key: 'posture.mute',
    group: 'posture',
    label: 'Mute & acknowledge findings',
    description:
      'Mute an exposure finding with a reason and an expiry, or acknowledge it to stop escalation without resolving it. A muted finding notifies nobody.',
    sensitive: true,
    defaults: MGR,
    current: [],
    endpoints: ['POST /api/posture/findings/:id/mute', 'POST /api/posture/findings/:id/acknowledge'],
    since: 5,
  },
  {
    key: 'posture.export',
    group: 'posture',
    label: 'Export posture data',
    description:
      'Download findings and listening-port inventories as CSV, JSON or PDF, for one server or in bulk. Separate from viewing because an export takes security data out of the product in a form that is no longer access-controlled.',
    sensitive: true,
    defaults: MGR,
    current: [],
    endpoints: ['GET /api/posture/export/fields', 'POST /api/posture/export'],
    since: 6,
  },
  {
    key: 'posture.expected_ports',
    group: 'posture',
    label: 'Mark ports as expected on a server',
    description:
      'Declare that a port is meant to be public on one specific host, which resolves its exposure findings and stops them reopening. Narrower than posture.settings, which does the same thing for the whole organization.',
    sensitive: true,
    defaults: MGR,
    current: [],
    endpoints: [
      'GET/POST /api/posture/servers/:id/expected-ports',
      'DELETE /api/posture/servers/:id/expected-ports/:entryId',
    ],
    since: 6,
  },
  {
    key: 'posture.settings',
    group: 'posture',
    label: 'Manage posture settings',
    description:
      'Turn posture collection on or off, set the collector interval and retention, maintain the expected-public port list, and edit alert routing rules.',
    sensitive: true,
    defaults: ADM,
    current: [],
    endpoints: ['GET/PUT /api/posture/settings', 'CRUD /api/posture/alert-rules'],
    since: 5,
  },

  // -------------------------------------------------------------------- roles
  {
    key: 'roles.view',
    group: 'roles',
    label: 'View roles',
    description: 'See roles and their permissions.',
    defaults: ADM,
    current: [],
    endpoints: ['GET /api/roles', 'GET /api/roles/:id'],
  },
  {
    key: 'roles.manage',
    delegable: false,
    group: 'roles',
    label: 'Manage roles',
    description: 'Create, edit and delete custom roles and edit built-in ones. You can only grant permissions you hold.',
    sensitive: true,
    defaults: ADM,
    current: [],
    endpoints: ['POST /api/roles', 'PUT /api/roles/:id', 'DELETE /api/roles/:id', 'POST /api/roles/:id/reset'],
  },

  // ----------------------------------------------------------------- settings
  {
    key: 'org.update',
    group: 'settings',
    label: 'Edit organization profile',
    description: 'Change the organization name, domain and logo.',
    defaults: ADM,
    current: ADM,
    endpoints: ['PUT /api/org'],
    findings: ['F-10', 'G3'],
  },
  {
    key: 'org.access_settings',
    group: 'settings',
    label: 'Access settings',
    description: 'Change organization-wide access rules.',
    sensitive: true,
    defaults: SA,
    current: SA,
    endpoints: ['GET/PUT /api/org/access-settings'],
  },
  {
    key: 'settings.sso',
    delegable: false,
    group: 'settings',
    label: 'Single sign-on',
    description: 'Configure SSO providers, auto-provisioning and their default role.',
    sensitive: true,
    defaults: SA,
    current: SA,
    endpoints: ['/api/auth/sso/config*', '/api/auth/sso/providers*', '/api/settings/directory-sync*'],
    findings: ['F-25'],
  },
  {
    key: 'settings.mfa',
    delegable: false,
    group: 'settings',
    label: 'MFA policy',
    description: 'Enable and enforce multi-factor authentication for the organization.',
    sensitive: true,
    defaults: SA,
    current: SA,
    endpoints: ['GET/PUT /api/settings/mfa'],
  },
  {
    key: 'settings.smtp',
    delegable: false,
    group: 'settings',
    label: 'Email delivery',
    description:
      'Configure how Shellius sends email (SMTP, Google, Microsoft 365, SendGrid, Mailgun, Postmark, Resend) for invitations, approvals, sign-in codes and alerts, and send test emails.',
    sensitive: true,
    defaults: SA,
    current: SA,
    endpoints: [
      'GET/POST /api/settings/email/providers',
      'GET/PUT/DELETE /api/settings/email/providers/:id',
      'POST /api/settings/email/providers/:id/{activate,deactivate,test,google/connect}',
      'GET/PUT/DELETE /api/settings/smtp (deprecated)',
      'POST /api/settings/smtp/test (deprecated)',
    ],
  },
  {
    key: 'settings.storage',
    delegable: false,
    group: 'settings',
    label: 'Recording storage',
    description: 'Configure where session recordings are stored. This setting is shared by every organization on this install.',
    sensitive: true,
    defaults: SA,
    current: SA,
    endpoints: ['GET/PUT/DELETE /api/settings/storage', 'POST /api/settings/storage/test'],
    findings: ['F-16'],
  },

  {
    key: 'settings.notifications',
    delegable: false,
    group: 'settings',
    label: 'Chat notifications',
    description:
      'Configure where notifications are sent — Slack, Google Chat, Teams or a webhook — and whether decisions may be made from chat.',
    sensitive: true,
    since: 8,
    defaults: SA,
    current: SA,
    endpoints: ['/api/settings/chat*'],
  },

  {
    key: 'audit.sinks',
    group: 'sessions',
    label: 'Configure audit destinations',
    description:
      'Send this organization\u2019s audit log to a webhook, object storage, syslog or a scheduled digest.',
    sensitive: true,
    defaults: SA,
    current: SA,
    delegable: false,
    endpoints: [
      'GET/POST /api/settings/audit-sinks',
      'GET/PUT/DELETE /api/settings/audit-sinks/:id',
      'POST /api/settings/audit-sinks/:id/test',
    ],
    since: 7,
  },

  {
    key: 'audit.retention',
    group: 'sessions',
    label: 'Set audit retention',
    description:
      'Decide how long audit entries are kept, and whether they are archived before being deleted. Audit history is otherwise kept forever.',
    sensitive: true,
    defaults: SA,
    current: SA,
    delegable: false,
    endpoints: ['GET/PUT /api/audit/retention', 'GET /api/audit/archives'],
    since: 7,
  },

  // ------------------------------------------------------------------- tokens
  {
    key: 'tokens.personal',
    group: 'tokens',
    label: 'Create personal API tokens',
    description:
      'Create tokens for your own scripts. A token can never do more than you can — its permissions are narrowed to your role on every request. Remove this from the Member role to turn personal tokens off for everyone.',
    defaults: M,
    current: M,
    delegable: false,
    endpoints: ['GET/POST /api/tokens', 'POST /api/tokens/:id/rotate', 'DELETE /api/tokens/:id'],
    since: 7,
  },
  {
    key: 'tokens.view_all',
    group: 'tokens',
    label: 'See everyone’s tokens',
    description: 'List the API tokens other people have created, and when each was last used.',
    defaults: ADM,
    current: ADM,
    endpoints: ['GET /api/users/:id/tokens'],
    since: 7,
  },
  {
    key: 'tokens.revoke_any',
    group: 'tokens',
    label: 'Revoke anyone’s token',
    description: 'Revoke an API token belonging to another user.',
    sensitive: true,
    defaults: ADM,
    current: ADM,
    delegable: false,
    endpoints: ['DELETE /api/users/:id/tokens/:tokenId'],
    since: 7,
  },
  {
    key: 'service_accounts.view',
    group: 'tokens',
    label: 'View service accounts',
    description: 'See the machine identities in this organization and what they can do.',
    defaults: ADM,
    current: ADM,
    endpoints: ['GET /api/service-accounts', 'GET /api/service-accounts/:id'],
    since: 7,
  },
  {
    key: 'service_accounts.manage',
    group: 'tokens',
    label: 'Manage service accounts',
    description:
      'Create machine identities for CI and scripts, choose their role and customer scope, and issue their tokens. You can only give a service account permissions you hold yourself.',
    sensitive: true,
    defaults: SA,
    current: SA,
    delegable: false,
    endpoints: [
      'POST /api/service-accounts',
      'PUT/DELETE /api/service-accounts/:id',
      'POST /api/service-accounts/:id/tokens',
      'DELETE /api/service-accounts/:id/tokens/:tokenId',
    ],
    since: 7,
  },
].map((p) => ({ since: 1, sensitive: false, delegable: true, findings: [], ...p }));

export const CATALOG_VERSION = Math.max(...PERMISSIONS.map((p) => p.since));

export const PERMISSION_KEYS = PERMISSIONS.map((p) => p.key);

/**
 * "Privileged" permissions — an account holding any of them is an attractive
 * takeover target, so linking a new SSO identity to it by email alone needs a
 * stronger proof (docs/auth-hardening.md "Linking SSO accounts"). Derived
 * from the catalogue, never from role names: every write permission in the
 * users / roles / settings groups (the view-only keys are excluded) plus
 * `access.prod_bypass`.
 */
export const PRIVILEGED_PERMISSIONS = PERMISSIONS.filter(
  (p) =>
    (['users', 'roles', 'settings'].includes(p.group) && !/\.view(_|$)/.test(p.key)) ||
    // Tokens by sensitivity, not by group: `tokens.personal` is a baseline
    // Member capability, so treating the whole group as privileged would
    // make every account privileged and stop SSO ever linking by email.
    // Only issuing machine identities and revoking other people's
    // credentials are takeover-grade.
    (p.group === 'tokens' && p.sensitive) ||
    p.key === 'access.prod_bypass'
).map((p) => p.key);

/**
 * Permissions an API token may never hold, however powerful its owner is.
 *
 * A token is a credential that lives in a CI variable or a config file, is
 * used unattended, and can't answer an MFA challenge. These are the actions
 * where that is the wrong trade: minting further credentials, changing who
 * can sign in or how, exporting private keys, rotating the CA, or bypassing
 * the approval flow. They stay things a person does in a session.
 *
 * Derived from the catalogue (`delegable: false`) rather than listed here,
 * so a new permission declares its own answer next to its description.
 */
export const NON_DELEGABLE_PERMISSIONS = PERMISSIONS.filter((p) => p.delegable === false).map((p) => p.key);
const KEY_SET = new Set(PERMISSION_KEYS);

export function isPermission(key) {
  return KEY_SET.has(key);
}

/** Default permission set for a built-in role of the given tier. */
export function defaultPermissionsFor(tier) {
  if (tier === 'super_admin') return [...PERMISSION_KEYS];
  return PERMISSIONS.filter((p) => p.defaults.includes(tier)).map((p) => p.key);
}

/** Drop unknown keys and duplicates, keep catalogue order. */
export function normalizePermissions(keys) {
  const wanted = new Set((keys || []).filter((k) => KEY_SET.has(k)));
  return PERMISSION_KEYS.filter((k) => wanted.has(k));
}

export const SYSTEM_ROLES = [
  {
    key: 'super_admin',
    name: 'Super admin',
    description: 'Owns the organization. Always has every permission and cannot be edited.',
  },
  {
    key: 'admin',
    name: 'Admin',
    description: 'Runs day-to-day administration: users, policies, Keystore, audit.',
  },
  {
    key: 'manager',
    name: 'Manager',
    description: 'Manages customers and servers, onboards hosts, sees sessions.',
  },
  {
    key: 'member',
    name: 'Member',
    description: 'Views the inventory and requests access to servers.',
  },
];
