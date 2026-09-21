import { serverPrimaryLabel, serverSecondaryLabel, serverSearchString } from '@/lib/serverLabel';

/**
 * ServerName — renders a server's display name as the primary label with the
 * hostname (or IP) as secondary text beneath it (when it adds information
 * beyond the primary label). Falls back to the hostname, then a provided
 * fallback. See lib/serverLabel.js for the string-only version of this rule.
 */
function ServerName({ server, fallback = '-', className = '' }) {
  if (!server) return <span className="text-sm text-foreground">{fallback}</span>;
  const primary = serverPrimaryLabel(server, fallback);
  const secondary = serverSecondaryLabel(server);
  return (
    <div className={`flex flex-col leading-tight ${className}`}>
      <span className="text-sm font-medium text-foreground">{primary}</span>
      {secondary && <span className="text-xs text-muted-foreground">{secondary}</span>}
    </div>
  );
}

// Re-exported for existing importers (components/services searching by name).
export { serverSearchString };

export default ServerName;
