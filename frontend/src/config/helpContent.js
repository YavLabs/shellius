/**
 * Per-page Help drawer content (Task 17D).
 *
 * Each entry is keyed by a page slug. PageHeader passes a `helpKey` prop;
 * the HelpButton looks up the entry and renders it inside HelpDrawer.
 *
 * Add a new page by dropping a new entry here — no other code change needed.
 */

export const HELP_CONTENT = {
  dashboard: {
    title: 'Dashboard',
    summary:
      "An at-a-glance view of your Shellius instance: server health, active sessions, pending access requests, and your own access permissions.",
    sections: [
      {
        heading: 'What you see here',
        body:
          'Stat cards show counts for servers (by health), active sessions, pending access requests, and certificates issued. The activity feed shows recent audit events. The "My Access" widget shows servers you currently have approved access to.',
      },
      {
        heading: 'How to use',
        body:
          'Click any stat card to drill into the matching list page. The activity feed is scoped to the last 24 hours.',
      },
    ],
  },

  customers: {
    title: 'Customers',
    summary:
      "Customers are the top-level grouping for servers. Use them to organize infrastructure by client, project, or business unit.",
    sections: [
      {
        heading: 'When to create one',
        body:
          'Create a customer for each distinct client, business unit, or project whose servers you want to manage independently. Servers are always assigned to a customer.',
      },
      {
        heading: 'Permissions',
        body:
          'Customer-scoped policies let you give specific users or groups access only to one customer\'s servers. Without scoping, policies apply org-wide.',
      },
    ],
  },

  servers: {
    title: 'Servers',
    summary:
      "Every host you want to access through Shellius — physical, virtual, cloud, on-prem. Each server has an environment tag (demo / dev / staging / prod) that drives the access policy that applies to it.",
    sections: [
      {
        heading: 'Adding a server',
        body:
          'Click "Add Server", fill in the hostname + IP + customer + environment + SSH user. After saving, a Bootstrap modal pops up with a one-line install command. Run it on the target host as root and Shellius will configure sshd to trust the org\'s CA.',
      },
      {
        heading: 'Connecting',
        body:
          'Click "Connect" on any row. If you have an active approved access request, it opens a web terminal in a new tab. Otherwise it opens the Request Access modal — fill in a reason, submit, and (for non-prod servers under the default policy) you\'ll be auto-approved and connected.',
      },
      {
        heading: 'Bootstrap & Uninstall',
        body:
          'The row menu also has Bootstrap Host (re-run the installer) and Uninstall Agent (remove the Shellius CA + check-principals script + sshd drop-in, leaving every other SSH file untouched).',
      },
      {
        heading: 'Environment matters',
        body:
          'Servers tagged "prod" always require manager approval before access is granted, regardless of any policy. This is a hard system invariant.',
      },
    ],
  },

  users: {
    title: 'Users',
    summary:
      "Everyone who can log in to Shellius. Roles control what they can see and do: super_admin > admin > operator > viewer.",
    sections: [
      {
        heading: 'Roles',
        body:
          'super_admin: full access, including CA rotation and SSO config. admin: org-wide read/write minus CA. operator: read-write servers, read-only policies, can review access requests. viewer: read-only.',
      },
      {
        heading: 'Inviting users',
        body:
          'Click "Invite User", enter their email and role. They receive a one-time link to set their password. The row menu also has Resend Invite and Send Password Reset.',
      },
      {
        heading: 'SSO users',
        body:
          'Users authenticated via SSO (Google, Entra ID, Okta, Auth0) cannot change their password — it\'s managed by the IdP. Local users can change their password from the Profile page.',
      },
    ],
  },

  groups: {
    title: 'Groups',
    summary:
      "Bundle users together so you can grant access to many people in one policy. A user can belong to multiple groups.",
    sections: [
      {
        heading: 'Why use groups',
        body:
          'Policies that target groups stay readable as your team grows. Adding a new engineer to "platform-team" automatically grants them everything that group has access to.',
      },
      {
        heading: 'Membership',
        body:
          'Open a group → Add Member → search and select. Removing a user from a group revokes group-derived access on the user\'s next access request, but does NOT revoke any active certificates.',
      },
    ],
  },

  policies: {
    title: 'Access Policies',
    summary:
      "Policies decide who can access which servers, for how long, and whether approval is required. Higher-priority policies override lower ones.",
    sections: [
      {
        heading: 'How evaluation works',
        body:
          'When a user requests access, Shellius walks every policy in priority order (highest first) and picks the first one whose subjects + targets match. If the matched policy is ALLOW with autoApprove, the request is approved instantly. If it requires approval, it goes to the manager queue. If a DENY matches first, access is refused.',
      },
      {
        heading: 'Default policies',
        body:
          'Fresh installs get three defaults: allow-non-prod (auto-approve dev/staging), prod-requires-approval, and deny-inactive. You can edit, disable, or delete any of them.',
      },
      {
        heading: 'Test before saving',
        body:
          'Open the Evaluator (row menu → Test, or the Evaluate button on the form) and pick a (user, server) pair. The result shows allow / deny / requires-approval and the matched rule, so you can sanity-check a policy before it goes live.',
      },
      {
        heading: 'Production override',
        body:
          'Servers tagged "prod" ALWAYS require manager approval, even if a higher-priority policy says auto-approve. This is a hard system invariant — not a setting.',
      },
    ],
  },

  'access-requests': {
    title: 'Access Requests',
    summary:
      "Every approved SSH/RDP session begins with an access request. Requests carry a reason, a duration, and the principal (Linux username) the cert will be issued for.",
    sections: [
      {
        heading: 'Lifecycle',
        body:
          'PENDING → APPROVED (or DENIED) → EXPIRED when the duration runs out, or REVOKED if a manager pulls access early. APPROVED requests can be used to connect any time before expiry.',
      },
      {
        heading: 'Reviewing',
        body:
          'Switch to the "Pending Reviews" tab. Click a request → review the requester, server, and reason → Approve (with optional duration override) or Deny (with reason). Both actions are audited.',
      },
      {
        heading: 'Connecting after approval',
        body:
          'Click the request row → "Open Web Terminal" — the live terminal opens in a new tab. Or use the Connect button on the Servers list to skip straight to the terminal.',
      },
    ],
  },

  certificates: {
    title: 'Certificates',
    summary:
      "Short-lived SSH certificates signed by the org's CA. Issued automatically per access request — never created or renewed manually.",
    sections: [
      {
        heading: 'How they\'re issued',
        body:
          'When you connect to a server, Shellius generates an ephemeral Ed25519 key pair, signs the public key with the org CA, and binds the cert to your username + the server. The private key is never stored server-side.',
      },
      {
        heading: 'Revoking',
        body:
          'Revoking a cert immediately invalidates it everywhere — the next time the user tries to connect, sshd will refuse the cert via check-principals. Use this if a session needs to be killed mid-use.',
      },
      {
        heading: 'Expiry alerts',
        body:
          'Certs expiring within 24 hours show an amber pill on the row, and a banner appears at the top of the page if any of yours are about to expire.',
      },
    ],
  },

  sessions: {
    title: 'Sessions',
    summary:
      "Live and historical SSH/RDP sessions. Each session corresponds to one open shell or remote desktop, audited from connect to disconnect.",
    sections: [
      {
        heading: 'Active sessions',
        body:
          'Switch to the Active tab to see sessions currently open. Admins can terminate any active session — the user is disconnected immediately and the action is audited.',
      },
      {
        heading: 'Recording playback',
        body:
          'SSH sessions are recorded to asciinema cast files. Click a session row to open the detail modal and replay the entire shell session at variable speed.',
      },
    ],
  },

  'audit-log': {
    title: 'Audit Log',
    summary:
      "Immutable record of every action in Shellius — logins, policy changes, access requests, cert issuance, sessions, configuration updates. Filter, search, and export.",
    sections: [
      {
        heading: 'What gets logged',
        body:
          'Authentication, every CRUD on every resource, every access request transition, every cert issuance/revocation, every session start/end, every configuration change. Audit entries are never updated or deleted.',
      },
      {
        heading: 'Filters',
        body:
          'Filter by action type, resource type, actor, or date range. Combine filters to narrow down a forensic investigation.',
      },
      {
        heading: 'Export',
        body:
          'Super admins can export the filtered view as CSV or JSON for compliance or external SIEM ingestion.',
      },
    ],
  },

  notifications: {
    title: 'Notifications',
    summary:
      "Account-level notifications: access request status changes, expiring certs, group invitations, security alerts.",
    sections: [
      {
        heading: 'Reading',
        body:
          'Click any row to mark it read and open the related entity. Use the "Unread only" filter to focus on what needs attention.',
      },
      {
        heading: 'Email',
        body:
          'Notification emails are sent based on your preferences in Settings → Notifications. Admins can configure SMTP under Settings → Notifications → SMTP.',
      },
    ],
  },

  settings: {
    title: 'Settings',
    summary:
      "Org-level configuration: organization name, CA management, SSO, notification + SMTP setup.",
    sections: [
      {
        heading: 'Organization',
        body:
          'Update your org\'s display name, domain, and logo URL.',
      },
      {
        heading: 'CA Management',
        body:
          'View the org\'s SSH CA fingerprint and public key. Super admins can rotate the CA — every existing certificate is invalidated and the new key takes over.',
      },
      {
        heading: 'SSO',
        body:
          'Configure single sign-on with Google Workspace, Microsoft Entra ID, Okta, Auth0, or any generic OIDC provider. Test the connection from the wizard before saving.',
      },
      {
        heading: 'Notifications',
        body:
          'Per-user toggle for email notifications and (admin only) the SMTP server settings. Env-var defaults are picked up automatically — UI overrides take precedence.',
      },
    ],
  },
};

export function getHelp(slug) {
  return HELP_CONTENT[slug] || null;
}
