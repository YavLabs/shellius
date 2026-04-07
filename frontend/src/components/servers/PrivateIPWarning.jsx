import { Wifi, AlertTriangle } from 'lucide-react';
import { isPrivateIP } from '@/utils/network';

/**
 * PrivateIPWarning — surfaces a "VPN may be required" notice when a
 * server's IP address looks private. Renders nothing for public IPs.
 *
 * variants:
 *   "banner" — full-width amber alert (default; for forms / modals / detail headers)
 *   "pill"   — small inline badge (for tables / dense rows)
 *   "note"   — soft compact line (for create/edit forms under the IP field)
 */
function PrivateIPWarning({ ipAddress, variant = 'banner' }) {
  if (!ipAddress || !isPrivateIP(ipAddress)) return null;

  if (variant === 'pill') {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300"
        title="Private network address — VPN may be required"
      >
        <Wifi className="h-3 w-3" />
        Private IP
      </span>
    );
  }

  if (variant === 'note') {
    return (
      <p className="mt-1 flex items-start gap-1.5 text-[11px] text-amber-700 dark:text-amber-400">
        <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
        <span>
          <code className="font-mono">{ipAddress}</code> looks like a private IP. The
          Shellius backend can only reach this host if it's on the same network.
          Connect to the appropriate VPN before connecting.
        </span>
      </p>
    );
  }

  // banner (default)
  return (
    <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-sm text-amber-800 dark:text-amber-200">
      <Wifi className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="flex-1">
        <p className="font-medium">Private network address</p>
        <p className="mt-0.5 text-xs text-amber-700/90 dark:text-amber-300/90">
          <code className="font-mono">{ipAddress}</code> looks like a private IP. The
          Shellius backend can only reach this host if it (or your browser, for
          direct downloads) is on the same network.{' '}
          <strong>Make sure you're connected to the appropriate VPN</strong> before
          connecting.
        </p>
      </div>
    </div>
  );
}

export default PrivateIPWarning;
