import { Wifi, AlertTriangle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { isPrivateIP } from '@/utils/network';

/**
 * PrivateIPWarning — explains what a private address means for reaching the
 * host: browser terminals connect from the Shellius backend, so the backend
 * must be able to reach that network; connecting from your own machine (CLI,
 * a downloaded key) needs your machine on it too. Renders nothing for public
 * IPs.
 *
 * variants:
 *   "banner" — full-width amber alert (default; for forms / modals / detail headers)
 *   "card"   — amber card sized to sit in a detail-page card grid
 *   "pill"   — small inline badge (for tables / dense rows)
 *   "note"   — soft compact line (for create/edit forms under the IP field)
 */
function PrivateIPWarning({ ipAddress, variant = 'banner' }) {
  if (!ipAddress || !isPrivateIP(ipAddress)) return null;

  if (variant === 'pill') {
    return (
      <Badge tone="warning" icon={Wifi} title="Private address: reachable only if the Shellius backend can reach this network">
        Private IP
      </Badge>
    );
  }

  if (variant === 'note') {
    return (
      <p className="mt-1 flex items-start gap-1.5 text-[11px] text-amber-700 dark:text-amber-400">
        <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
        <span>
          <code className="font-mono">{ipAddress}</code> is a private address. It works only if the
          Shellius backend can reach this network.
        </span>
      </p>
    );
  }

  if (variant === 'card') {
    return (
      <div className="rounded-lg border border-amber-500/40 bg-amber-500/5">
        <div className="flex items-center gap-2 border-b border-amber-500/30 px-5 py-3">
          <Wifi className="h-4 w-4 text-amber-600 dark:text-amber-400" />
          <h3 className="text-sm font-semibold text-amber-800 dark:text-amber-200">
            Private network address
          </h3>
        </div>
        <div className="px-5 py-4 text-xs leading-relaxed text-amber-800/90 dark:text-amber-200/90">
          <code className="font-mono">{ipAddress}</code> is a private address.{' '}
          <span className="font-medium">Browser terminals connect from the Shellius backend</span>,
          so they work only if the backend can reach this network. To connect from your own machine
          (the CLI or a downloaded key), your machine needs to be on it too — over VPN, for example.
        </div>
      </div>
    );
  }

  // banner (default)
  return (
    <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-sm text-amber-800 dark:text-amber-200">
      <Wifi className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="flex-1">
        <p className="font-medium">Private network address</p>
        <p className="mt-0.5 text-xs text-amber-700/90 dark:text-amber-300/90">
          <code className="font-mono">{ipAddress}</code> is a private address.{' '}
          <strong>Browser terminals connect from the Shellius backend</strong>, so they work only if
          the backend can reach this network. To connect from your own machine (the CLI or a
          downloaded key), your machine needs to be on it too, for example over VPN.
        </p>
      </div>
    </div>
  );
}

export default PrivateIPWarning;
