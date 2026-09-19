import { Cable, Lock, Server, SquareTerminal, Zap, ChevronRight } from 'lucide-react';
import PageHeader from '@/components/common/PageHeader';
import { NavGroup, NavRow, SearchLauncher } from '@/components/mobile/MobileNavList';
import { RecentConnections } from '@/components/dashboard/RecentConnectionsWidget';
import { useAuth } from '@/context/AuthContext';
import { useQuickConnect } from '@/context/QuickConnectContext';
import { useCommandPalette } from '@/context/CommandPaletteContext';
import { useTerminalWorkspace } from '@/context/TerminalWorkspaceContext';
import { canAccessRoute } from '@/lib/commands';

/**
 * Connect — the phone bottom navigation's "Connect" tab: everything about
 * getting onto a machine on one page. Quick connect, the open terminal
 * workspace, the pages that list targets (Servers, My hosts) and your recent
 * connections (same rows and actions as the dashboard widget). Every entry
 * follows ROUTE_ACCESS / the Quick connect permission; works on desktop too.
 */
function ConnectHub() {
  const { user } = useAuth();
  const { allowed: quickConnectAllowed, openQuickConnect } = useQuickConnect();
  const { openPalette } = useCommandPalette();
  const { tabs = [], liveCount = 0 } = useTerminalWorkspace();

  const openTabs = tabs.length;
  const canServers = canAccessRoute(user, '/servers');
  const canHosts = canAccessRoute(user, '/my-hosts');

  return (
    <div className="space-y-6 p-6">
      <PageHeader icon={Cable} title="Connect" subtitle="Get onto a server, one of your hosts or any address." />

      <SearchLauncher onClick={openPalette} placeholder="Search servers and hosts…" />

      {quickConnectAllowed && (
        <button
          type="button"
          onClick={() => openQuickConnect()}
          className="group flex w-full items-center gap-3 rounded-lg border border-[hsl(var(--brand)/0.35)] bg-[hsl(var(--brand)/0.08)] p-3.5 text-left transition-colors active:bg-[hsl(var(--brand)/0.14)]"
        >
          <span className="bg-brand-gradient flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-[color:var(--brand-on-gradient)]">
            <Zap className="h-5 w-5" aria-hidden="true" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold text-foreground">Quick connect</span>
            <span className="block truncate text-xs text-muted-foreground">Any host by address, with a stored or one-time identity</span>
          </span>
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/60" aria-hidden="true" />
        </button>
      )}

      <NavGroup label="Go to">
        <NavRow
          icon={SquareTerminal}
          label="Terminals"
          description={openTabs ? `${openTabs} open ${openTabs === 1 ? 'tab' : 'tabs'}` : 'Your terminal workspace'}
          count={liveCount}
          countTone="live"
          to="/terminals"
        />
        {canServers && <NavRow icon={Server} label="Servers" description="Every server you can request or connect to" to="/servers" />}
        {canHosts && <NavRow icon={Lock} label="My hosts" description="Your private hosts" to="/my-hosts" />}
      </NavGroup>

      {/* Its "View all" leads to the full Recent connections page. */}
      <RecentConnections variant="widget" showQuickConnect={false} />
    </div>
  );
}

export default ConnectHub;
