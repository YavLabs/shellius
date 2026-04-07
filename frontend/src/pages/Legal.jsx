import { useParams, Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';

/**
 * Legal — single page that renders Privacy / Terms / EULA based on the
 * `:doc` route param. Content is intentionally lightweight placeholder
 * text suitable for a self-hosted product; operators are expected to
 * adapt these to their jurisdiction before going to production.
 */

const DOCS = {
  privacy: {
    title: 'Privacy Policy',
    intro:
      'Shellius is a self-hosted product. The instance you are using is operated by your organization, not by the Shellius project itself. Any personal data you enter — including your name, email address, SSH usernames, and connection metadata — is stored on infrastructure controlled by the operator of this instance.',
    sections: [
      {
        h: 'What we collect',
        body:
          'Account profile (name, email, role), authentication metadata (login timestamps, refresh-token fingerprints), access requests (reason text, requested duration, target host), session metadata, and audit-log entries for every privileged action. Optional asciinema-format session recordings are stored when enabled by the operator.',
      },
      {
        h: 'What we never store',
        body:
          'Plaintext SSH private keys are generated on demand and returned to the requesting user — they are never written to disk on the server. RDP credentials are injected directly into the Guacamole gateway and never returned to the browser. Cleartext passwords are hashed with bcrypt; cleartext secrets (CA private key, cloud connector keys, SMTP/SSO passwords) are encrypted at rest with AES-256-GCM.',
      },
      {
        h: 'Your rights',
        body:
          'You can export every record we hold about you as a JSON archive from Profile → Export my data. You can delete your account from Profile → Delete account; the account is soft-deleted immediately, hidden from listings, and hard-purged after a 30-day grace window.',
      },
      {
        h: 'Contact',
        body:
          'Questions about this instance — including data subject requests under GDPR or comparable regimes — should go to the operator of your Shellius deployment, not to the upstream project.',
      },
    ],
  },
  terms: {
    title: 'Terms of Service',
    intro:
      'By using this Shellius instance you agree to the following terms. These terms cover the relationship between you (the user) and the operator of this deployment.',
    sections: [
      {
        h: 'Acceptable use',
        body:
          'You may only access servers and resources that you have been explicitly authorized to access. Attempts to bypass approval workflows, exfiltrate the CA private key, or escalate privileges outside the policy engine are prohibited and will be logged and reported.',
      },
      {
        h: 'Account responsibility',
        body:
          'You are responsible for safeguarding your account credentials. Every action taken under your account — including SSH connections, RDP sessions, and access requests — is attributed to you in the audit log.',
      },
      {
        h: 'Service availability',
        body:
          'Shellius is provided on an "as is" basis. Operators may take the service offline for maintenance, upgrades, or incident response without prior notice.',
      },
      {
        h: 'Termination',
        body:
          'Operators may suspend or terminate your access at any time for violation of these terms or for operational reasons.',
      },
    ],
  },
  eula: {
    title: 'End User License Agreement',
    intro:
      'The Shellius software is licensed under the GNU Affero General Public License v3.0 (AGPL-3.0). The full license text is included in the source repository.',
    sections: [
      {
        h: 'License grant',
        body:
          'You are granted the right to use, copy, modify, and redistribute the Shellius source code under the terms of the AGPL-3.0. If you run a modified version as a network service, you must make the corresponding source code available to its users.',
      },
      {
        h: 'No warranty',
        body:
          'Shellius is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the AGPL-3.0 for details.',
      },
      {
        h: 'Trademark',
        body:
          'The Shellius name and logo are not part of the AGPL grant. You may not use them to endorse or promote derivative products without explicit written permission from the Shellius project maintainers.',
      },
      {
        h: 'Source code',
        body: 'The full source for this version is available at https://github.com/vaidyayash8/shellius.',
      },
    ],
  },
};

function Legal() {
  const { doc } = useParams();
  const content = DOCS[doc];

  if (!content) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-10">
        <p className="text-sm text-muted-foreground">Document not found.</p>
        <Link to="/dashboard" className="mt-4 inline-flex items-center gap-1 text-sm text-primary hover:underline">
          <ArrowLeft className="h-4 w-4" /> Back to dashboard
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      <Link
        to="/dashboard"
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" /> Back
      </Link>
      <h1 className="mb-2 text-3xl font-bold tracking-tight text-foreground">{content.title}</h1>
      <p className="mb-8 text-sm text-muted-foreground">
        Last updated: {new Date().toISOString().slice(0, 10)}
      </p>
      <p className="mb-8 text-base leading-relaxed text-foreground/90">{content.intro}</p>
      <div className="space-y-6">
        {content.sections.map((s) => (
          <section key={s.h}>
            <h2 className="mb-2 text-lg font-semibold text-foreground">{s.h}</h2>
            <p className="text-sm leading-relaxed text-muted-foreground">{s.body}</p>
          </section>
        ))}
      </div>
    </div>
  );
}

export default Legal;
