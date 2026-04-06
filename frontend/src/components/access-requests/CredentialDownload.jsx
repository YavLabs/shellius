import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Terminal, Download, Copy, Check, AlertTriangle, ExternalLink } from 'lucide-react';
import { getSshCredentials, getRdpCredentials, startConnect } from '@/services/accessRequestService';
import { formatDateTime } from '@/utils/time';

function useCountdown(targetDate) {
  const [label, setLabel] = useState('');

  useEffect(() => {
    if (!targetDate) return;

    const tick = () => {
      const diff = new Date(targetDate).getTime() - Date.now();
      if (diff <= 0) {
        setLabel('Expired');
        return;
      }
      const s = Math.floor(diff / 1000);
      const m = Math.floor(s / 60);
      const h = Math.floor(m / 60);
      const d = Math.floor(h / 24);
      if (d > 0) setLabel(`${d}d ${h % 24}h remaining`);
      else if (h > 0) setLabel(`${h}h ${m % 60}m remaining`);
      else if (m > 0) setLabel(`${m}m ${s % 60}s remaining`);
      else setLabel(`${s}s remaining`);
    };

    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [targetDate]);

  return label;
}

function downloadBlob(filename, content) {
  const blob = new Blob([content], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore
    }
  };

  return (
    <button
      onClick={handleCopy}
      className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
      title="Copy to clipboard"
    >
      {copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

function CredentialDownload({ request }) {
  const navigate = useNavigate();
  const countdown = useCountdown(request?.expiresAt || request?.certificate?.validBefore);

  const [sshLoading, setSshLoading] = useState(false);
  const [rdpLoading, setRdpLoading] = useState(false);
  const [connectLoading, setConnectLoading] = useState(false);
  const [sshCreds, setSshCreds] = useState(null);
  const [error, setError] = useState('');

  if (!request || request.status !== 'APPROVED') return null;

  const protocol = request.protocol || 'SSH';

  const handleSshDownload = async () => {
    setSshLoading(true);
    setError('');
    try {
      const resp = await getSshCredentials(request.id);
      const creds = resp.data || resp;
      setSshCreds(creds);
      if (creds.privateKey) {
        downloadBlob('id_ed25519', creds.privateKey);
      }
      if (creds.certificate) {
        downloadBlob('id_ed25519-cert.pub', creds.certificate);
      }
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message || 'Failed to retrieve SSH credentials.');
    } finally {
      setSshLoading(false);
    }
  };

  const handleRdpDownload = async () => {
    setRdpLoading(true);
    setError('');
    try {
      const resp = await getRdpCredentials(request.id);
      const creds = resp.data || resp;
      if (creds.content && creds.filename) {
        // content may be base64 or plain text
        let fileContent;
        try {
          fileContent = atob(creds.content);
        } catch {
          fileContent = creds.content;
        }
        downloadBlob(creds.filename, fileContent);
      }
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message || 'Failed to retrieve RDP credentials.');
    } finally {
      setRdpLoading(false);
    }
  };

  const handleConnect = async () => {
    setConnectLoading(true);
    setError('');
    try {
      const resp = await startConnect(request.id);
      const url = resp.data?.url || resp.url;
      if (url) {
        navigate(url);
      }
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message || 'Failed to start web session.');
    } finally {
      setConnectLoading(false);
    }
  };

  return (
    <div className="mt-4 space-y-4 rounded-lg border border-border p-4">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-semibold text-foreground">Access Credentials</h4>
        {countdown && (
          <span className={`text-xs font-medium ${countdown === 'Expired' ? 'text-destructive' : 'text-amber-600 dark:text-amber-400'}`}>
            {countdown}
          </span>
        )}
      </div>

      {/* Warning banner */}
      {protocol === 'SSH' && (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <p className="text-xs text-amber-700 dark:text-amber-300">
            The private key is only shown once. Download and save it immediately — it cannot be retrieved again.
          </p>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {/* Open Web Terminal */}
        <button
          onClick={handleConnect}
          disabled={connectLoading}
          className="flex items-center gap-2 rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground hover:bg-accent disabled:opacity-50"
        >
          <ExternalLink className="h-4 w-4" />
          {connectLoading ? 'Connecting...' : 'Open Web Terminal'}
        </button>

        {/* SSH Download */}
        {protocol === 'SSH' && (
          <button
            onClick={handleSshDownload}
            disabled={sshLoading}
            className="flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            <Download className="h-4 w-4" />
            {sshLoading ? 'Downloading...' : 'Download SSH Key'}
          </button>
        )}

        {/* RDP Download */}
        {protocol === 'RDP' && (
          <button
            onClick={handleRdpDownload}
            disabled={rdpLoading}
            className="flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            <Download className="h-4 w-4" />
            {rdpLoading ? 'Downloading...' : 'Download RDP File'}
          </button>
        )}
      </div>

      {/* Connect command shown after SSH download */}
      {sshCreds?.connectCommand && (
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Connect Command</p>
          <div className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2">
            <code className="flex-1 font-mono text-xs text-foreground break-all">
              {sshCreds.connectCommand}
            </code>
            <CopyButton text={sshCreds.connectCommand} />
          </div>
        </div>
      )}

      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}
    </div>
  );
}

export default CredentialDownload;
