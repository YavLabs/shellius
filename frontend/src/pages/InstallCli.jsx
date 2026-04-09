import { useState } from 'react';
import {
  Copy,
  Check,
  Terminal as TerminalIcon,
  Download,
  ExternalLink,
} from 'lucide-react';
import PageHeader from '@/components/common/PageHeader';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GITHUB_REPO = 'vaidyayash8/shellius';
const RELEASES_URL = `https://github.com/${GITHUB_REPO}/releases/latest`;

// ---------------------------------------------------------------------------
// Sub-components (self-contained — no shared Settings state needed)
// ---------------------------------------------------------------------------

function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text || '');
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* ignore */
    }
  };

  return (
    <button
      onClick={handleCopy}
      className="ml-2 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded border border-input bg-background text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
      title="Copy to clipboard"
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
    </button>
  );
}

function SectionCard({ title, description, children }) {
  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="border-b border-border px-5 py-4">
        <h2 className="text-base font-semibold text-foreground">{title}</h2>
        {description && (
          <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      <div className="px-5 py-4">{children}</div>
    </div>
  );
}

function CodeBlock({ code, language = 'bash' }) {
  return (
    <div className="relative rounded-md border border-border bg-muted/40 font-mono text-xs">
      <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
        <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
          {language}
        </span>
        <CopyButton text={code} />
      </div>
      <pre className="overflow-x-auto px-3 py-2.5 text-foreground">
        <code>{code}</code>
      </pre>
    </div>
  );
}

function KeyRow({ keys, label }) {
  return (
    <div className="flex items-center gap-2">
      <div className="flex items-center gap-1">
        {keys.map((k, i) => (
          <span
            key={i}
            className="inline-flex h-6 min-w-[1.5rem] items-center justify-center rounded border border-border bg-muted px-1.5 font-mono text-[11px] font-medium text-foreground"
          >
            {k}
          </span>
        ))}
      </div>
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

function InstallCli() {
  const publicUrl =
    typeof window !== 'undefined' ? window.location.origin : 'https://shellius.yavlabs.com';

  // The installer is served directly from this deployment at
  // /api/cli/install.sh — no GitHub round-trip needed. The script
  // itself still downloads the platform binary from GitHub releases,
  // but the entry point stays on-prem.
  const installScriptUrl = `${publicUrl}/api/cli/install.sh`;
  const oneLiner = `curl -fsSL ${installScriptUrl} | sh`;
  const loginCmd = `shellius login ${publicUrl}`;
  const brewCmd = `brew install ${GITHUB_REPO.split('/')[1]}  # (planned)`;

  const uninstallSteps = [
    {
      label: 'Find the install location',
      code: 'which shellius',
    },
    {
      label: 'Remove the binary',
      code: 'rm "$(command -v shellius)"',
    },
    {
      label: 'Remove config and cached credentials',
      code: 'rm -rf ~/.shellius',
    },
  ];

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        icon={TerminalIcon}
        title="Install the Shellius CLI"
        subtitle="A terminal client for browsing hosts, requesting access, and connecting over SSH."
        helpKey="install-cli"
      />

      {/* Hero */}
      <div className="rounded-lg border border-border bg-card p-6">
        <div className="flex items-start gap-4">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-primary">
            <TerminalIcon className="h-6 w-6 text-primary-foreground" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-semibold text-foreground">Shellius CLI</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              A terminal client for your laptop that lets you browse your
              active access requests and SSH into approved hosts with a
              single keystroke. Install once, sign in once, then{' '}
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">shellius</code>
              {' '}opens directly to your available servers every time.
            </p>
            <p className="mt-2 text-xs text-muted-foreground">
              <strong className="text-foreground">This is NOT installed on target hosts</strong> —
              only on developer machines. Targets use the bootstrap script from
              the Servers page.
            </p>
          </div>
        </div>
      </div>

      {/* One-liner install */}
      <SectionCard
        title="Quick install (macOS &amp; Linux)"
        description="Runs a signed script that downloads the latest release binary for your OS + arch, verifies its SHA256 checksum, and installs it to /usr/local/bin (or ~/.local/bin if non-root)."
      >
        <CodeBlock code={oneLiner} language="bash" />
        <p className="mt-3 text-xs text-muted-foreground">
          After install, confirm the version with{' '}
          <code className="rounded bg-muted px-1 font-mono">shellius --version</code>.
        </p>
      </SectionCard>

      {/* Login */}
      <SectionCard
        title="First-time login"
        description="Sign in once using the device-authorization flow. Your tokens persist in ~/.shellius/credentials (0600) and refresh automatically — no more logging in on every run."
      >
        <CodeBlock code={loginCmd} language="bash" />
        <p className="mt-3 text-xs text-muted-foreground">
          The CLI will print a short code and open a browser for you to
          approve the device. Once approved, close the browser tab and you&apos;re
          logged in.
        </p>
      </SectionCard>

      {/* Daily usage */}
      <SectionCard
        title="Daily usage"
        description="Keyboard shortcuts inside the TUI."
      >
        <div className="space-y-2 text-sm">
          <KeyRow keys={['↑', '↓']} label="Navigate the active-access list" />
          <KeyRow keys={['↵']} label="SSH into the selected server" />
          <KeyRow keys={['/']} label="Open the slash-command palette (fuzzy search)" />
          <KeyRow keys={['?']} label="Open the help overlay" />
          <KeyRow keys={['Ctrl', '+', 'C']} label="Quit" />
        </div>

        <div className="mt-4 rounded-md border border-border bg-muted/30 p-3">
          <p className="text-xs font-semibold text-foreground">Available slash commands</p>
          <ul className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground font-mono">
            <li>/help</li>
            <li>/servers</li>
            <li>/request</li>
            <li>/sessions</li>
            <li>/refresh</li>
            <li>/profile</li>
            <li>/logout</li>
            <li>/quit</li>
          </ul>
        </div>
      </SectionCard>

      {/* Manual install fallback */}
      <SectionCard
        title="Manual download"
        description="If you can&apos;t pipe curl into sh, grab the binary directly."
      >
        <ul className="space-y-2 text-sm">
          <li>
            <a
              href={RELEASES_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-primary hover:underline"
            >
              <Download className="h-3.5 w-3.5" />
              Latest releases on GitHub
              <ExternalLink className="h-3 w-3" />
            </a>
          </li>
          <li className="text-xs text-muted-foreground">
            Pick the asset matching your OS + architecture:
            {' '}
            <code className="rounded bg-muted px-1 font-mono">shellius-linux-amd64</code>,
            {' '}
            <code className="rounded bg-muted px-1 font-mono">shellius-linux-arm64</code>,
            {' '}
            <code className="rounded bg-muted px-1 font-mono">shellius-darwin-amd64</code>,
            {' '}
            <code className="rounded bg-muted px-1 font-mono">shellius-darwin-arm64</code>,
            {' '}
            <code className="rounded bg-muted px-1 font-mono">shellius-windows-amd64.exe</code>.
            Each comes with a <code className="rounded bg-muted px-1 font-mono">.sha256</code>{' '}
            sidecar for verification.
          </li>
          <li className="text-xs text-muted-foreground">
            Homebrew formula: <code className="rounded bg-muted px-1 font-mono">{brewCmd}</code>
          </li>
        </ul>
      </SectionCard>

      {/* Diagnose */}
      <SectionCard
        title="Troubleshooting"
        description={`If something isn't working, run "shellius doctor" — it prints config path, token expiry, and the last refresh result so you can diagnose without source-diving.`}
      >
        <CodeBlock code="shellius doctor" language="bash" />
      </SectionCard>

      {/* Uninstall */}
      <SectionCard
        title="Uninstall"
        description="Run these steps on your machine to fully remove the Shellius CLI."
      >
        <div className="space-y-4">
          <div className="flex items-start gap-3">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border bg-muted text-xs font-semibold text-muted-foreground">
              1
            </div>
            <div className="flex-1 min-w-0">
              <p className="mb-2 text-sm text-foreground">Find the install location</p>
              <CodeBlock code={uninstallSteps[0].code} language="bash" />
            </div>
          </div>

          <div className="flex items-start gap-3">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border bg-muted text-xs font-semibold text-muted-foreground">
              2
            </div>
            <div className="flex-1 min-w-0">
              <p className="mb-2 text-sm text-foreground">Remove the binary</p>
              <CodeBlock code={uninstallSteps[1].code} language="bash" />
            </div>
          </div>

          <div className="flex items-start gap-3">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border bg-muted text-xs font-semibold text-muted-foreground">
              3
            </div>
            <div className="flex-1 min-w-0">
              <p className="mb-2 text-sm text-foreground">Remove config and cached credentials</p>
              <CodeBlock code={uninstallSteps[2].code} language="bash" />
            </div>
          </div>

          <div className="flex items-start gap-3">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border bg-muted text-xs font-semibold text-muted-foreground">
              4
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm text-foreground">
                (Optional) Clean up <code className="rounded bg-muted px-1 font-mono text-xs">~/.ssh/known_hosts</code>
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                If the CLI added entries for Shellius-managed hosts, remove the
                relevant lines manually. Hostnames vary by deployment so there is
                no single command to run — open the file in an editor and search
                for your Shellius domain.
              </p>
            </div>
          </div>
        </div>
      </SectionCard>
    </div>
  );
}

export default InstallCli;
