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
      'Everyone who can log in to Shellius. Each user has one role, and the role\'s permissions decide what they can see and do.',
    sections: [
      {
        heading: 'Roles',
        body:
          'Built-in roles: Super admin (every permission, cannot be edited), Admin, Manager and Member. Admin, Manager and Member can be edited, and you can create custom roles under Administration → Roles — e.g. an Admin with a few extra settings. You can only assign roles whose permissions you hold yourself. Skipping production approval is the "Production without approval" permission (Admin by default).',
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
    title: 'Access policies',
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
          'Notification emails are sent based on your notification preferences on your Profile. Admins choose how email is delivered (SMTP, Google, Microsoft 365, SendGrid, Mailgun, Postmark or Resend) under Administration → Email.',
      },
    ],
  },

  keystore: {
    title: 'Keystore',
    summary:
      "A deliberate, admin-sanctioned exception to Shellius's zero-static-keys model for hosts that can't or shouldn't be bootstrapped with the org CA — appliances, customer-owned boxes, legacy systems. Store reusable identities and SSH keys, export/rotate keys across hosts, and connect ad-hoc without saving a server.",
    sections: [
      {
        heading: 'Identities vs CA certificates',
        body:
          'Normal Shellius access uses a short-lived certificate signed by the org CA — nothing is stored. An "Identity" here is a stored username + password and/or private key that Shellius uses instead, for servers set to authMode "credential". Saved servers still go through the request/approval flow either way, and "prod" always requires approval regardless of authMode.',
      },
      {
        heading: 'Password, key, or both',
        body:
          'Identities support authType password, key, or key_password (both — the key is tried first, then the password, which also satisfies hosts that require both via SSH partial success).',
      },
      {
        heading: 'Importing keys',
        body:
          'Supported private key formats (auto-detected, not by extension): OpenSSH (including bcrypt-encrypted), PEM PKCS#1 RSA and SEC1 EC (including legacy encrypted RSA), PKCS#8 (plain or encrypted), and PuTTY .ppk v2/v3 (encrypted v3 uses Argon2). Key types: Ed25519, RSA, ECDSA (nistp256/384/521) — DSA is rejected. Encrypted keys stay passphrase-protected at rest, in addition to AES-256-GCM encryption.',
      },
      {
        heading: 'Certificates on a key',
        body:
          'A stored key can optionally carry an OpenSSH user certificate signed by another CA. When present, connections authenticate with the certificate instead of the raw key.',
      },
      {
        heading: 'Export to servers',
        body:
          'The wizard pushes (Export), removes, or rotates a key across one or more servers. Rotate deploys the new key, verifies login, removes the old key, and — if requested — repoints every identity using the old key to the new one. Authenticate using each server\'s own access (its CA cert or stored identity) or a specific identity, and optionally use sudo to write another user\'s authorized_keys.',
      },
      {
        heading: 'Host key pinning',
        body:
          "Every connection pins the target's SSH host key on first use (TOFU). A mismatch on a later connection refuses the session until an admin resets the pin from the server's detail page — this guards against man-in-the-middle attacks on hosts Shellius doesn't control.",
      },
      {
        heading: 'Security notes',
        body:
          'All secret material (private keys, passphrases, identity passwords) is AES-256-GCM encrypted at rest and only decrypted in memory at connect/export time. List and detail views never return secrets — only derived metadata (hasPassword, hasPassphrase, public key, fingerprint). Exporting a private key is an admin-only, fully audited action.',
      },
    ],
  },

  'my-hosts': {
    title: 'My hosts',
    summary:
      "Your own private SSH address book — name, host, username and an identity to connect with. My hosts are never servers: they don't appear in the inventory, policies, approvals, dashboards, health checks, search or the TUI, and nobody else — not even admins — can see them.",
    sections: [
      {
        heading: 'Identities',
        body:
          'Attach one of your personal identities (Keystore → Personal), an organization identity if your role allows it, or pick "Ask each time" to enter a password or key on each connection — nothing typed there is ever stored.',
      },
      {
        heading: 'Same connection guards as Quick Connect',
        body:
          "Connecting goes through the same ticket engine as Quick Connect: loopback/link-local/metadata addresses are blocked, and a host matching a saved production server is refused — use the access-request flow for that host instead.",
      },
      {
        heading: 'Host key pinning',
        body:
          'The first successful connection pins the host\'s SSH key (TOFU); a mismatch afterward blocks the connection until you reset the pin yourself.',
      },
      {
        heading: 'Turned off?',
        body:
          'An admin can turn off personal vault for the whole organization (Administration → Access rules). While off, your hosts and identities are kept but hidden and unusable until it\'s turned back on.',
      },
    ],
  },

  roles: {
    title: 'Roles',
    summary:
      'A role is a named set of permissions. Every user has exactly one role, and what they can see and do follows from it.',
    sections: [
      {
        heading: 'Built-in and custom roles',
        body:
          'Super admin always has every permission and cannot be changed. Admin, Manager and Member can be edited and reset to their defaults. Create a custom role from scratch or duplicate an existing one.',
      },
      {
        heading: 'No escalation',
        body:
          'You can only create, edit, assign or delete a role whose permissions you hold yourself, and nobody can edit their own role.',
      },
      {
        heading: 'List and matrix',
        body:
          'The list shows each role with its member count; the matrix shows every permission against every role. Open a role to change its permissions — unsaved changes are kept until you save or discard them.',
      },
    ],
  },

  admin: {
    title: 'Administration',
    summary:
      'Everything an admin configures for this organization: people and roles, sign-in and security rules, organization settings and integrations. You only see the sections your role\'s permissions allow.',
    sections: [
      {
        heading: 'People & access',
        body:
          'Users (invite, suspend, reset passwords, sign-in methods), Roles (what each role can do) and Groups (bundle users for policies).',
      },
      {
        heading: 'Authentication',
        body:
          'Single sign-on: Google Workspace, Microsoft Entra ID, Okta, Auth0, GitHub or any generic OIDC provider — test the connection from the wizard before saving. Two-factor: enable and enforce authenticator apps (TOTP) or email codes. Access rules: whether roles with "Production without approval" may skip production approval, require SSO, and the personal vault switch.',
      },
      {
        heading: 'Organization',
        body:
          'General: display name, domain and logo URL. Certificate authority: the org\'s SSH CA fingerprint and public key; roles with the rotate permission can rotate it — every existing certificate is invalidated. Quick Connect: the org-wide switch for ad-hoc SSH connections.',
      },
      {
        heading: 'Integrations',
        body:
          'Email: add one or more providers (SMTP, Google / Gmail API, Microsoft 365 via Graph, SendGrid, Mailgun, Postmark, Resend) and make one active. Use "Send test email" to check delivery; failures show the provider’s own error. With no active provider, email falls back to the server’s SMTP_* settings, or is not sent. Storage: where session recordings are kept (MinIO, AWS S3 or Azure Blob). Chat notifications: post access requests, break-glass and posture findings to Slack, Google Chat, Microsoft Teams or a webhook — only a Slack app (bot token) can carry approve/deny buttons or a direct message, and an empty customer list sends only org-wide events, not everything.',
      },
      {
        heading: 'Finding a setting',
        body:
          'Type in the search box above the sections — it matches names and keywords, so "smtp" finds Email and "okta" finds Single sign-on. Old Settings links (/settings?tab=…) and the old /users, /roles and /groups pages redirect here.',
      },
    ],
  },

  posture: {
    title: 'Posture',
    summary:
      "Exposure findings for every server that reports a posture snapshot: what's listening, who owns it, and whether the host firewall actually protects it — including Docker ports that bypass ufw/firewalld entirely.",
    sections: [
      {
        heading: 'Reading a finding',
        body:
          'Each finding names the port, the owning process (container, pm2 app or systemd unit) and why it matters. Severity ranges from Critical (e.g. a datastore reachable despite a firewall rule you believe covers it) to Info (an intentionally public port like 22 or 443).',
      },
      {
        heading: 'Muting',
        body:
          'Mute a finding you have reviewed and accept, with a reason and an expiry. Muted findings stop notifying — including escalations — until the mute expires or is removed, and still show under the Muted tab.',
      },
      {
        heading: 'A server that stops reporting',
        body:
          "Findings never silently clear because a collector died — a stale server keeps its last-known findings and is flagged separately so it isn't mistaken for clean.",
      },
    ],
  },
};

// Settings became Administration in 1.5.0; the old key still resolves.
HELP_CONTENT.settings = HELP_CONTENT.admin;

export function getHelp(slug) {
  return HELP_CONTENT[slug] || null;
}
