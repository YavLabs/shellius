#!/usr/bin/env node
/**
 * Email template preview script. Renders a template with sample vars
 * and prints the HTML + plain-text + subject to stdout.
 *
 * Usage: node backend/scripts/preview-email.js <template-name>
 *
 * Example:
 *   node backend/scripts/preview-email.js invite > /tmp/invite.html
 *   xdg-open /tmp/invite.html   # or open on macOS
 */

import { renderTemplate, TEMPLATE_NAMES } from '../src/email/index.js';

const SAMPLES = {
  invite: {
    recipientName: 'Alice Anderson',
    orgName: 'Acme Corp',
    inviteUrl: 'https://shellius.example.com/invite/abc123def456',
    expiresInHours: 168,
  },
  passwordReset: {
    recipientName: 'Alice Anderson',
    resetUrl: 'https://shellius.example.com/password-reset/abc123def456',
    expiresInHours: 1,
  },
  passwordChanged: {
    recipientName: 'Alice Anderson',
    ipAddress: '203.0.113.42',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X) Chrome/146.0.0.0',
    when: new Date().toISOString(),
  },
  accessRequestSubmitted: {
    reviewerName: 'Bob Reviewer',
    requesterName: 'Alice Anderson',
    serverHostname: 'prod-db-01.example.com',
    environment: 'prod',
    reason: 'Index bloat investigation — checking pg_stat_user_indexes',
    reviewUrl: 'https://shellius.example.com/access-requests',
  },
  accessRequestApproved: {
    recipientName: 'Alice Anderson',
    serverHostname: 'prod-db-01.example.com',
    environment: 'prod',
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    connectUrl: 'https://shellius.example.com/servers/abc123',
  },
  accessRequestDenied: {
    recipientName: 'Alice Anderson',
    serverHostname: 'prod-db-01.example.com',
    deniedReason: 'Please file a change ticket via the SRE portal first.',
  },
  certificateExpiring: {
    recipientName: 'Alice Anderson',
    serverHostname: 'prod-db-01.example.com',
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    renewUrl: 'https://shellius.example.com/access-requests',
  },
};

const name = process.argv[2];
if (!name) {
  console.error('Usage: node preview-email.js <template>');
  console.error('Available:', TEMPLATE_NAMES.join(', '));
  process.exit(1);
}

const vars = SAMPLES[name];
if (!vars) {
  console.error(`No sample vars defined for template "${name}"`);
  process.exit(1);
}

const result = renderTemplate(name, vars);

if (process.argv.includes('--text')) {
  console.log(result.text);
} else if (process.argv.includes('--subject')) {
  console.log(result.subject);
} else {
  console.log(result.html);
}
