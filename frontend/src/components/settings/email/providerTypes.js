import { Server, Mail, Building2, Send, Zap, Inbox, Rocket } from 'lucide-react';

/**
 * Email provider catalogue for Administration → Email. Mirrors the backend
 * adapters (backend/src/services/email/providers). `secret: true` fields are
 * write-only: the API returns { set } for them and keeps the stored value
 * when the field is left blank on edit.
 *
 * Field: { key, label, kind: 'text'|'email'|'number'|'password'|'select'|'textarea',
 *          options?, placeholder?, required?, secret?, help?, showIf?(values) }
 */

const REGION_US_EU = [
  { value: 'us', label: 'US' },
  { value: 'eu', label: 'EU' },
];

export const EMAIL_PROVIDER_TYPES = [
  {
    type: 'smtp',
    label: 'SMTP',
    description: 'Any SMTP server or relay (Postfix, Exchange, Amazon SES SMTP…).',
    icon: Server,
    fromRequired: false,
    help: 'Use port 587 with STARTTLS or 465 with TLS. "None" still upgrades to TLS when the server offers it.',
    defaults: { port: 587, security: 'starttls' },
    fields: [
      { key: 'host', label: 'Host', kind: 'text', placeholder: 'smtp.example.com', required: true },
      { key: 'port', label: 'Port', kind: 'number', placeholder: '587', required: true },
      {
        key: 'security',
        label: 'Security',
        kind: 'select',
        options: [
          { value: 'starttls', label: 'STARTTLS (required)' },
          { value: 'tls', label: 'TLS (implicit, usually 465)' },
          { value: 'none', label: 'None (STARTTLS if offered)' },
        ],
      },
      { key: 'username', label: 'Username', kind: 'text', placeholder: 'optional' },
      { key: 'password', label: 'Password', kind: 'password', secret: true },
    ],
  },
  {
    type: 'google',
    label: 'Google (Gmail API)',
    description: 'Send as a Gmail / Google Workspace mailbox over the Gmail API.',
    icon: Mail,
    fromRequired: false,
    help:
      'OAuth: create an OAuth client (Web application) in Google Cloud, enable the Gmail API, add the redirect URI shown below, then click "Connect Google account". Shellius only asks for the gmail.send scope. Service account: enable domain-wide delegation for the scope https://www.googleapis.com/auth/gmail.send in the Workspace admin console.',
    defaults: { mode: 'oauth' },
    fields: [
      {
        key: 'mode',
        label: 'Authentication',
        kind: 'select',
        options: [
          { value: 'oauth', label: 'Connect a Google account (OAuth)' },
          { value: 'service_account', label: 'Workspace service account (domain-wide delegation)' },
        ],
      },
      {
        key: 'clientId',
        label: 'OAuth client ID',
        kind: 'text',
        placeholder: '…apps.googleusercontent.com',
        help: 'Leave blank to use the server’s SSO_GOOGLE_CLIENT_ID.',
        showIf: (v) => v.mode !== 'service_account',
      },
      {
        key: 'clientSecret',
        label: 'OAuth client secret',
        kind: 'password',
        secret: true,
        help: 'Leave blank to use SSO_GOOGLE_CLIENT_SECRET.',
        showIf: (v) => v.mode !== 'service_account',
      },
      {
        key: 'serviceAccountJson',
        label: 'Service account JSON key',
        kind: 'textarea',
        secret: true,
        required: true,
        placeholder: '{ "type": "service_account", "client_email": "…", "private_key": "…" }',
        showIf: (v) => v.mode === 'service_account',
      },
      {
        key: 'delegatedUser',
        label: 'Send as (Workspace mailbox)',
        kind: 'email',
        required: true,
        placeholder: 'alerts@example.com',
        showIf: (v) => v.mode === 'service_account',
      },
    ],
  },
  {
    type: 'microsoft',
    label: 'Microsoft 365 (Graph)',
    description: 'Send from an Exchange Online mailbox with Microsoft Graph.',
    icon: Building2,
    fromRequired: false,
    help:
      'In Entra ID register an app, add the Microsoft Graph application permission Mail.Send and grant admin consent, then create a client secret. Restrict the app to the sender mailbox with an Exchange application access policy.',
    defaults: {},
    fields: [
      { key: 'tenantId', label: 'Directory (tenant) ID', kind: 'text', placeholder: '00000000-0000-… or contoso.onmicrosoft.com', required: true },
      { key: 'clientId', label: 'Application (client) ID', kind: 'text', placeholder: '00000000-0000-…', required: true },
      { key: 'clientSecret', label: 'Client secret', kind: 'password', secret: true, required: true },
      { key: 'sender', label: 'Sender mailbox (UPN)', kind: 'email', placeholder: 'alerts@contoso.com', required: true },
    ],
  },
  {
    type: 'sendgrid',
    label: 'SendGrid',
    description: 'Twilio SendGrid Web API v3.',
    icon: Send,
    fromRequired: true,
    help: 'Create an API key with the "Mail Send" permission. The from address must be a verified sender or on an authenticated domain.',
    defaults: { region: 'us' },
    fields: [
      { key: 'apiKey', label: 'API key', kind: 'password', secret: true, required: true, placeholder: 'SG.…' },
      { key: 'region', label: 'Region', kind: 'select', options: REGION_US_EU, help: 'EU for accounts with EU data residency.' },
    ],
  },
  {
    type: 'mailgun',
    label: 'Mailgun',
    description: 'Mailgun Messages API.',
    icon: Inbox,
    fromRequired: true,
    help: 'Use a sending API key for the domain. The from address must be on that domain.',
    defaults: { region: 'us' },
    fields: [
      { key: 'apiKey', label: 'API key', kind: 'password', secret: true, required: true },
      { key: 'domain', label: 'Sending domain', kind: 'text', placeholder: 'mg.example.com', required: true },
      { key: 'region', label: 'Region', kind: 'select', options: REGION_US_EU },
    ],
  },
  {
    type: 'postmark',
    label: 'Postmark',
    description: 'Postmark Email API.',
    icon: Zap,
    fromRequired: true,
    help: 'Use the Server API token (Server → API Tokens). The from address must be a confirmed sender signature or domain.',
    defaults: { messageStream: 'outbound' },
    fields: [
      { key: 'serverToken', label: 'Server API token', kind: 'password', secret: true, required: true },
      { key: 'messageStream', label: 'Message stream', kind: 'text', placeholder: 'outbound' },
    ],
  },
  {
    type: 'resend',
    label: 'Resend',
    description: 'Resend Emails API.',
    icon: Rocket,
    fromRequired: true,
    help: 'Create an API key with sending access. The from address must be on a verified domain.',
    defaults: {},
    fields: [{ key: 'apiKey', label: 'API key', kind: 'password', secret: true, required: true, placeholder: 're_…' }],
  },
];

export function getEmailProviderType(type) {
  return EMAIL_PROVIDER_TYPES.find((t) => t.type === type) || null;
}
