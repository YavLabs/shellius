import { useCallback, useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Cable } from 'lucide-react';
import PageHeader from '@/components/common/PageHeader';
import { RecentConnections } from '@/components/dashboard/RecentConnectionsWidget';
import useAutoRefresh from '@/hooks/useAutoRefresh';

/**
 * Connections — full view behind the dashboard widget's "View all": every
 * active session of yours plus recent server and Quick Connect connections,
 * with search, a type filter and a 7/30-day range. Same rows and actions
 * as the widget (components/dashboard/RecentConnectionsWidget.jsx).
 */
function Connections() {
  const { hash } = useLocation();

  // "View all" links land on #active / #recent: scroll there once rendered.
  useEffect(() => {
    if (!hash) return undefined;
    const t = setTimeout(() => document.getElementById(hash.slice(1))?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 400);
    return () => clearTimeout(t);
  }, [hash]);

  // RecentConnections owns its own fetch; bumping this key makes it reload
  // without disturbing the page's search/filter/range state.
  const [refreshKey, setRefreshKey] = useState(0);
  const load = useCallback(async () => {
    setRefreshKey((k) => k + 1);
  }, []);
  const { refresh, refreshing, lastUpdated } = useAutoRefresh(load);

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        icon={Cable}
        title="Recent connections"
        subtitle="Your active sessions, and the servers and hosts you connected to recently."
        onRefresh={refresh}
        refreshing={refreshing}
        lastUpdated={lastUpdated}
      />
      <RecentConnections variant="page" refreshKey={refreshKey} />
    </div>
  );
}

export default Connections;
