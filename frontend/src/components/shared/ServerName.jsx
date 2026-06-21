/**
 * ServerName — renders a server's display name as the primary label with the
 * hostname as secondary text beneath it (when they differ). Falls back to the
 * hostname, then a provided fallback.
 */
function ServerName({ server, fallback = '-', className = '' }) {
  if (!server) return <span className="text-sm text-foreground">{fallback}</span>;
  const primary = server.displayName || server.hostname || server.name || fallback;
  const showHost =
    server.hostname && server.displayName && server.displayName !== server.hostname;
  return (
    <div className={`flex flex-col leading-tight ${className}`}>
      <span className="text-sm font-medium text-foreground">{primary}</span>
      {showHost && <span className="text-xs text-muted-foreground">{server.hostname}</span>}
    </div>
  );
}

/** Build a search string covering both display name and hostname. */
export function serverSearchString(server) {
  if (!server) return '';
  return [server.displayName, server.hostname, server.name, server.environment]
    .filter(Boolean)
    .join(' ');
}

export default ServerName;
